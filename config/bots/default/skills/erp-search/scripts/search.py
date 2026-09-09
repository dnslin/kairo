#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 裁剪自 ragflow-skill 1.0.8 的 search.py/common.py（MIT-0），见 ../SOURCE.md。

import http.client
import json
import math
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

MAX_SAFE_INTEGER = 2**53 - 1


class DataError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # 凭证只能发送到配置的检索端点，任何重定向均交还错误分类。
        return None


def failure(kind, reason, message, *, http_status=None, api_code=None, raw=None):
    return {
        "kind": kind,
        "httpStatus": http_status,
        "apiCode": api_code,
        "raw": raw,
        "error": {"reason": reason, "message": message},
    }


def finite_number(value):
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def reject_constant(value):
    raise ValueError("JSON 包含非有限数字")


def parse_number(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("JSON 包含非有限数字")
    return number


def decode_response(body):
    # JSON 无法解析时保留原始文本，避免把网关响应误认为无资料。
    text = body.decode("utf-8", errors="replace")
    try:
        raw = json.loads(body.decode("utf-8"), parse_constant=reject_constant, parse_float=parse_number)
        return raw, True
    except (UnicodeDecodeError, ValueError, RecursionError):
        return text, False


def network_diagnostic(error):
    reason = error.reason if isinstance(error, urllib.error.URLError) else error
    details = {"exceptionType": type(reason).__name__}
    for source, target in (("errno", "errno"), ("verify_code", "verifyCode")):
        value = getattr(reason, source, None)
        if type(value) is int:
            details[target] = value
    return details


def read_response(status, response):
    try:
        raw, valid_json = decode_response(response.read())
        return status, raw, valid_json, False
    except (OSError, http.client.HTTPException) as error:
        details = network_diagnostic(error)
        if isinstance(error, http.client.IncompleteRead):
            details["partial"] = error.partial.decode("utf-8", errors="replace")
        # 已收到的 HTTP 状态不可因响应体读取失败而丢失。
        return status, details, False, True


def request_json(url, api_key, body):
    # 复用上游 urllib Request/HTTPError 的单次请求路径；不引入重试或第二套超时。
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    request_obj = urllib.request.Request(url, headers=headers, data=body, method="POST")
    # 不读取环境或系统代理配置，避免凭证经另一个未配置的目标转发。
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request_obj) as response:
            return read_response(response.status, response)
    except urllib.error.HTTPError as exc:
        with exc:
            return read_response(exc.code, exc)


def normalize_chunk(chunk, index):
    if not isinstance(chunk, dict):
        raise DataError(f"data.chunks[{index}] 必须是对象")
    names = {
        "id": "chunkId",
        "document_id": "documentId",
        "document_keyword": "documentName",
        "dataset_id": "datasetId",
        "content": "content",
    }
    normalized = {}
    for source, target in names.items():
        value = chunk.get(source)
        if not isinstance(value, str) or not value:
            raise DataError(f"data.chunks[{index}].{source} 必须是非空字符串")
        normalized[target] = value
    positions = chunk.get("positions")
    if not isinstance(positions, list) or any(
        not isinstance(row, list) or any(not finite_number(value) for value in row)
        for row in positions
    ):
        raise DataError(f"data.chunks[{index}].positions 必须是有限数字二维数组")
    normalized["positions"] = positions
    for source, target in (
        ("similarity", "similarity"),
        ("vector_similarity", "vectorSimilarity"),
        ("term_similarity", "termSimilarity"),
    ):
        if source == "similarity" or source in chunk:
            value = chunk.get(source)
            if not finite_number(value):
                raise DataError(f"data.chunks[{index}].{source} 必须是有限数字")
            normalized[target] = value
    return normalized


def classify_response(status, raw, valid_json, dataset_id, read_error=False):
    code = raw.get("code") if isinstance(raw, dict) else None
    api_code = code if type(code) is int and -MAX_SAFE_INTEGER <= code <= MAX_SAFE_INTEGER else None
    message = raw.get("message") if isinstance(raw, dict) else None
    message = message if isinstance(message, str) and message else f"检索接口返回 HTTP {status}"
    details = {"http_status": status, "api_code": api_code, "raw": raw}
    # HTTP 状态先于业务码；非 JSON 的 HTTP 错误也必须保留状态与正文。
    if status in (401, 403):
        return failure("auth_error", "http", message, **details)
    if status in (400, 422):
        return failure("parameter_error", "http", message, **details)
    if status == 429 or 500 <= status <= 599:
        return failure("service_error", "http", message, **details)
    if not 200 <= status <= 299:
        return failure("service_error", "http", message, **details)
    if read_error:
        return failure("service_error", "network", "检索响应体读取失败", **details)
    if not valid_json or not isinstance(raw, dict):
        return failure("format_error", "response_format", "检索响应必须是有效 JSON 对象", **details)
    if api_code is None:
        return failure("format_error", "response_format", "检索响应 code 必须是安全范围内的整数", **details)
    if code != 0:
        # T14/T27 真实样本确认两种 102 消息；不以错误码单独推断类别。
        kind = "service_error"
        if code == 102 and message == f"You don't own the dataset {dataset_id}.":
            kind = "auth_error"
        elif code == 102 and message == "`question` is required.":
            kind = "parameter_error"
        return failure(kind, "api", message, **details)
    try:
        data = raw.get("data")
        if not isinstance(data, dict):
            raise DataError("检索响应 data 必须是对象")
        chunks = data.get("chunks")
        if not isinstance(chunks, list):
            raise DataError("检索响应 data.chunks 必须是数组")
        total = data.get("total")
        if type(total) is not int or total < 0:
            raise DataError("检索响应 data.total 必须是非负整数")
        normalized = [normalize_chunk(chunk, index) for index, chunk in enumerate(chunks)]
    except DataError as exc:
        return failure("format_error", "response_format", str(exc), **details)
    return {
        "kind": "found" if normalized else "empty",
        "httpStatus": status,
        "apiCode": api_code,
        "raw": raw,
        "chunks": normalized,
        "total": total,
    }


def search():
    if len(sys.argv) != 1:
        return failure("parameter_error", "input", "检索入口不接受命令行参数，仅接受 stdin 问题")
    try:
        query = sys.stdin.buffer.read().decode("utf-8")
    except (UnicodeDecodeError, OSError):
        return failure("parameter_error", "input", "stdin 必须是有效 UTF-8 问题")
    if not query.strip():
        return failure("parameter_error", "input", "检索问题不能为空")
    base_url = os.environ.get("RAGFLOW_API_URL", "").strip()
    api_key = os.environ.get("RAGFLOW_API_KEY", "")
    dataset_id = os.environ.get("RAGFLOW_DATASET_ID", "")
    if not base_url or not api_key.strip() or not dataset_id.strip():
        return failure("parameter_error", "configuration", "检索服务地址、凭证和固定 Dataset 均须配置")
    try:
        parsed = urllib.parse.urlsplit(base_url)
        if (
            parsed.scheme not in ("http", "https") or not parsed.hostname
            or parsed.username is not None or parsed.password is not None
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment
            or any(ord(char) < 33 for char in base_url)
        ):
            raise ValueError("非法检索基址")
        parsed.port
        api_key.encode("latin-1")
        if "\r" in api_key or "\n" in api_key:
            raise ValueError("非法凭证请求头")
    except (ValueError, UnicodeError):
        return failure("parameter_error", "configuration", "检索配置必须使用有效 HTTP(S) 服务基址与凭证")
    body = json.dumps({"question": query, "dataset_ids": [dataset_id]}, ensure_ascii=False).encode("utf-8")
    try:
        status, raw, valid_json, read_error = request_json(f"{base_url.rstrip('/')}/api/v1/retrieval", api_key, body)
    except (urllib.error.URLError, OSError, http.client.HTTPException) as error:
        # 保留安全的异常类型和系统错误码，不输出可能携带凭证的异常全文。
        return failure("service_error", "network", "检索服务网络请求失败", raw=network_diagnostic(error))
    return classify_response(status, raw, valid_json, dataset_id, read_error)


def redact(value, api_key):
    if isinstance(value, str):
        return value.replace(api_key, "[REDACTED]")
    if isinstance(value, list):
        return [redact(item, api_key) for item in value]
    if isinstance(value, dict):
        return {key.replace(api_key, "[REDACTED]"): redact(item, api_key) for key, item in value.items()}
    return value


def main():
    result = search()
    raw = result["raw"]
    code = raw.get("code") if isinstance(raw, dict) else None
    api_key = os.environ.get("RAGFLOW_API_KEY", "")
    if api_key:
        result = redact(result, api_key)
    if type(code) is int and not -MAX_SAFE_INTEGER <= code <= MAX_SAFE_INTEGER:
        # 先脱敏再保存 JSON 文本，避免 Node 解析超范围业务码时舍入或溢出。
        result["raw"] = json.dumps(result["raw"], ensure_ascii=False, allow_nan=False)
    # 固定 UTF-8 管道输出，独立于 Windows 控制台及被 -I 忽略的 PYTHON* 环境。
    output = json.dumps(result, ensure_ascii=True, allow_nan=False)
    sys.stdout.buffer.write((output + "\n").encode("utf-8"))
    sys.stdout.buffer.flush()
    return 0 if result["kind"] in ("found", "empty") else 1


if __name__ == "__main__":
    raise SystemExit(main())
