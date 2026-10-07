from __future__ import annotations

import json
import os
import ssl
from copy import deepcopy
from functools import wraps
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse
from urllib.request import ProxyHandler, Request, build_opener

BRIDGE_CONTEXT_CAPABILITIES = {
    "version": 1,
    "workerIsolation": True,
    "stableConversationId": True,
    "singleCompressionOwner": True,
    "contextOwnerStatus": True,
}


def normalize_context_manager(value: Any) -> dict[str, Any]:
    if value is None:
        return {"manager": "native", "allowNativeFallback": False}
    if not isinstance(value, dict) or value.get("manager") not in {"native", "bili"}:
        raise ValueError("invalid Studio context manager")
    fallback = value.get("allowNativeFallback", False)
    if not isinstance(fallback, bool):
        raise ValueError("allowNativeFallback must be a boolean")
    result = {"manager": value["manager"], "allowNativeFallback": fallback}
    if value["manager"] == "bili" or value.get("proxyUrl") is not None:
        result["proxyUrl"] = validate_origin(value.get("proxyUrl"))
    if value.get("caBundlePath") is not None and value["manager"] == "bili":
        path = value["caBundlePath"]
        if not isinstance(path, str) or not path or not Path(path).is_absolute():
            raise ValueError("caBundlePath must be an absolute certificate bundle path")
        result["caBundlePath"] = path
    return result


def validate_origin(value: Any) -> str:
    origin = str(value or "").strip()
    parsed = urlparse(origin)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise ValueError("bili proxyUrl must be an HTTP(S) origin without credentials or a path")
    return origin.rstrip("/")


def worker_environment(inherited: dict[str, str], config: dict[str, Any] | None) -> dict[str, str]:
    config = normalize_context_manager(config)
    env = dict(inherited)
    env["HERMES_STUDIO_CONTEXT_MANAGER"] = json.dumps(config, sort_keys=True)
    # Native preserves an independently enabled Hermes plugin. Explicit bili
    # attaches only this worker, before plugin discovery captures its singleton.
    if config["manager"] == "bili":
        env.update({"BILLION_CONTEXT_ATTACH": config["proxyUrl"], "BILI_NATIVE_HERMES": "1", "BILLION_CONTEXT_PLUGIN": "1"})
        env.pop("BILLION_CONTEXT_PROXY", None)
        env.pop("BILI_PROVIDER_REWRITES", None)
        if config.get("caBundlePath"):
            for name in ("HERMES_CA_BUNDLE", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"):
                env[name] = config["caBundlePath"]
    return env


def worker_config() -> dict[str, Any]:
    return normalize_context_manager(json.loads(os.environ.get("HERMES_STUDIO_CONTEXT_MANAGER", "null")))


def public_request(origin: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    origin = validate_origin(origin)
    if not path.startswith("/__bili/") or ".." in path:
        raise ValueError("invalid bili public endpoint")
    request = Request(origin + path, data=json.dumps(body).encode() if body is not None else None, headers={"content-type": "application/json"})
    # Control requests must go straight to the configured proxy, not its own
    # HTTPS_PROXY forwarding transport. Redirects may not change authority.
    import urllib.request
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    with build_opener(ProxyHandler({}), NoRedirect()).open(request, timeout=10) as response:
        value = json.load(response)
    if not isinstance(value, dict) or value.get("ok") is not True:
        raise RuntimeError("bili public protocol returned an unsuccessful response")
    return value


def validate_manifest(value: dict[str, Any]) -> None:
    headers = value.get("headers") or {}
    tools = (value.get("tools") or {}).get("anthropic")
    version = value.get("protocolVersion")
    if not isinstance(version, int) or isinstance(version, bool) or version < 1 or not isinstance(tools, list) or not tools or headers.get("conversation") != "x-bili-plugin-conversation":
        raise RuntimeError("bili manifest does not support stable Hermes plugin conversations")
    names = value.get("toolNames")
    if not isinstance(names, list) or not names or not all(isinstance(name, str) and name for name in names) or len(set(names)) != len(names):
        raise RuntimeError("bili manifest has invalid tool names")
    if not {"compress", "decompress", "search_context", "acp_status", "acp_cache"}.issubset(names):
        raise RuntimeError("bili manifest must advertise all five public tools")
    for name in names:
        matches = [tool for tool in tools if isinstance(tool, dict) and tool.get("name") == name]
        if len(matches) != 1 or not isinstance(matches[0].get("input_schema"), dict) or matches[0]["input_schema"].get("type") != "object":
            raise RuntimeError("bili manifest has missing or duplicate Hermes tool schemas")


def discover_context_owner(session_id: str) -> dict[str, Any]:
    config = worker_config()
    selected = config["manager"]
    active = False
    try:
        from hermes_cli.plugins import get_plugin_manager
        manager = get_plugin_manager()
        manager.discover_and_load()
        active = any(row.get("name") == "billion-context" and row.get("enabled") is True and not row.get("error") and row.get("middleware", 0) > 0 and row.get("tools", 0) > 0 for row in manager.list_plugins())
    except (ImportError, AttributeError):
        if selected == "bili":
            raise RuntimeError("Hermes public plugin discovery is unavailable for bili")
    if selected == "bili" and not active:
        raise RuntimeError("selected bili Hermes plugin is not active; ownership cannot be established")
    owner = "bili" if active else "native"
    result: dict[str, Any] = {"manager": owner, "owner": owner, "selectedManager": selected, "independentPlugin": active and selected == "native", "conversationId": session_id, "allowNativeFallback": config["allowNativeFallback"]}
    if active:
        origin = (config.get("proxyUrl") if selected == "bili" else None) or os.environ.get("BILLION_CONTEXT_ATTACH") or os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
        if not origin:
            raise RuntimeError("active bili Hermes plugin has no public proxy origin; cannot establish compression ownership")
        result["proxyUrl"] = validate_origin(origin)
        verify_proxy_environment(result["proxyUrl"])
        if config.get("caBundlePath"):
            result["caBundlePath"] = config["caBundlePath"]
            bind_bili_ca(result)
        manifest = public_request(result["proxyUrl"], "/__bili/plugin/manifest")
        validate_manifest(manifest)
        result["protocolVersion"] = manifest["protocolVersion"]
    return result


def origin_key(value: str) -> tuple[str, str, int]:
    parsed = urlparse(validate_origin(value))
    return parsed.scheme, parsed.hostname.lower(), parsed.port if parsed.port is not None else (443 if parsed.scheme == "https" else 80)


def verify_proxy_environment(origin: str) -> None:
    proxies = [os.environ[name] for name in ("HTTPS_PROXY", "https_proxy") if os.environ.get(name)]
    if not proxies or any(origin_key(proxy) != origin_key(origin) for proxy in proxies):
        raise RuntimeError("bili actual HTTPS proxy does not match the owned public proxy origin")


def bind_bili_ca(owner: dict[str, Any]) -> None:
    path = owner.get("caBundlePath")
    if path:
        # Discovery can overwrite worker CA env with the plugin's global XDG CA.
        try:
            ssl.create_default_context(cafile=path)
        except (OSError, ssl.SSLError) as exc:
            raise RuntimeError("bili profile CA bundle is missing or invalid") from exc
        for name in ("HERMES_CA_BUNDLE", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"):
            os.environ[name] = path


def verify_bili_transport(agent: Any, owner: dict[str, Any], sdk: Any = None) -> None:
    import httpx
    import httpcore

    verify_proxy_environment(owner["proxyUrl"])
    mode = getattr(agent, "api_mode", None)
    if mode not in {"chat_completions", "anthropic", "anthropic_messages", "codex_responses"}:
        raise RuntimeError("bili cannot verify this provider transport")
    if sdk is None:
        sdk = getattr(agent, "_anthropic_client" if mode in {"anthropic", "anthropic_messages"} else "client", None)
    if mode == "codex_responses":
        from openai import OpenAI
        from agent.transports.codex import ResponsesApiTransport

        get_transport = getattr(agent, "_get_transport", None)
        if (not callable(get_transport) or type(get_transport()) is not ResponsesApiTransport
                or not callable(getattr(agent, "_run_codex_stream", None)) or type(sdk) is not OpenAI):
            raise RuntimeError("bili requires a verifiable HTTP Responses provider transport")
    http = getattr(sdk, "_client", None)
    url = getattr(sdk, "base_url", None)
    if not isinstance(http, httpx.Client) or not url:
        raise RuntimeError("bili requires a verifiable HTTP provider transport")
    destination = httpx.URL(str(url))
    if destination.scheme != "https":
        raise RuntimeError("bili requires an HTTPS provider transport")
    # Respect NO_PROXY and URL mounts; checking the default pool is insufficient.
    transport = http._transport_for_url(destination)
    pool = getattr(transport, "_pool", None)
    proxy = getattr(pool, "_proxy_url", None)
    if not isinstance(pool, httpcore.HTTPProxy) or proxy is None:
        raise RuntimeError("bili provider transport bypasses the owned proxy")
    scheme = proxy.scheme.decode()
    actual = (scheme, proxy.host.decode().lower(), proxy.port if proxy.port is not None else (443 if scheme == "https" else 80))
    if actual != origin_key(owner["proxyUrl"]):
        raise RuntimeError("bili provider transport uses a different proxy origin")
    context = getattr(pool, "_ssl_context", None)
    if not isinstance(context, ssl.SSLContext) or context.verify_mode != ssl.CERT_REQUIRED or not context.check_hostname:
        raise RuntimeError("bili provider transport must verify TLS and hostnames")
    path = owner.get("caBundlePath")
    if path:
        try:
            expected = set(ssl.create_default_context(cafile=path).get_ca_certs(binary_form=True))
            if not expected or not expected.issubset(set(context.get_ca_certs(binary_form=True))):
                raise RuntimeError("bili provider transport does not trust the bound profile CA")
        except (OSError, ssl.SSLError) as exc:
            raise RuntimeError("bili profile CA bundle is missing or invalid") from exc


def ensure_bili_agent(agent: Any, owner: dict[str, Any]) -> None:
    identity = getattr(agent, "session_id", None)
    previous = getattr(agent, "_bridge_bili_conversation_id", identity)
    if not isinstance(identity, str) or not identity or identity != previous or identity == getattr(agent, "_parent_session_id", None):
        raise RuntimeError("bili delegated conversation identity must be stable and independent of its parent")
    install_bili_compression_guard(agent, identity)
    verify_bili_transport(agent, owner)
    manifest = owner.get("_manifest") or public_request(owner["proxyUrl"], "/__bili/plugin/manifest")
    validate_manifest(manifest)
    from tools.registry import registry
    tools = list(getattr(agent, "tools", None) or [])
    for name in manifest["toolNames"]:
        advertised = next(tool for tool in manifest["tools"]["anthropic"] if tool["name"] == name)
        entry = registry.get_entry(name)
        schema = advertised["input_schema"]
        definition = {"type": "function", "function": {"name": name, "description": advertised.get("description", ""), "parameters": deepcopy(schema)}}
        if entry is None or entry.toolset != "billion-context" or not callable(entry.handler) or entry.schema not in (schema, definition["function"]):
            raise RuntimeError(f"bili tool registration conflict: {name}")
        matching = [tool for tool in tools if isinstance(tool, dict) and (tool.get("function") or {}).get("name") == name]
        if len(matching) > 1:
            raise RuntimeError(f"bili final tool conflict: {name}")
        if matching:
            current = matching[0]["function"]
            # Installed plugins register raw input schemas; repair their envelope
            # only after matching the live registry-owned schema to the manifest.
            if current.get("parameters") != schema and current != {**schema, "name": name}:
                raise RuntimeError(f"bili final tool schema conflict: {name}")
            tools[tools.index(matching[0])] = definition
        else:
            tools.append(definition)
    agent.tools = tools
    agent.valid_tool_names = {tool["function"]["name"] for tool in tools}
    agent._bridge_bili_conversation_id = identity


def _bili_request_kwargs(agent: Any, api_kwargs: dict[str, Any]) -> dict[str, Any]:
    # Plugin middleware may carry the previous turn's output cap. Stamp a copy
    # at dispatch, never SDK defaults or proxy-wide agent/model runtime-info.
    managed = {"x-bili-plugin-context-window", "x-bili-plugin-model", "x-bili-plugin-max-output"}
    headers = {key: value for key, value in dict(api_kwargs.get("extra_headers") or {}).items()
               if key.lower() not in managed}
    model = api_kwargs.get("model")
    if isinstance(model, str) and model:
        headers["x-bili-plugin-model"] = model
        compressor = getattr(agent, "context_compressor", None)
        if (model == getattr(agent, "model", None) and compressor is not None
                and all(getattr(compressor, key, None) == getattr(agent, key, None)
                        for key in ("model", "provider", "base_url", "api_mode"))):
            window = getattr(compressor, "context_length", None)
            if isinstance(window, int) and not isinstance(window, bool) and window > 0:
                headers["x-bili-plugin-context-window"] = str(window)
        output = next((api_kwargs[key] for key in ("max_output_tokens", "max_completion_tokens", "max_tokens")
                       if key in api_kwargs),
                      getattr(agent, "max_tokens", None) if model == getattr(agent, "model", None) else None)
        if isinstance(output, int) and not isinstance(output, bool) and output > 0:
            headers["x-bili-plugin-max-output"] = str(output)
    return {**api_kwargs, "extra_headers": headers}


def install_bili_worker_guard(agent_class: type, owner: dict[str, Any]) -> None:
    if owner.get("manager") != "bili":
        return
    binding = {key: owner[key] for key in ("proxyUrl", "caBundlePath") if key in owner}
    installed = getattr(agent_class, "_bridge_bili_worker_binding", None)
    if installed is not None:
        if installed != binding:
            raise RuntimeError("bili worker cannot change its proxy or profile CA binding")
        return
    policy = {**binding, "_manifest": public_request(binding["proxyUrl"], "/__bili/plugin/manifest")}
    validate_manifest(policy["_manifest"])
    original_init = agent_class.__init__

    @wraps(original_init)
    def initialize(agent: Any, *args: Any, **kwargs: Any) -> None:
        bind_bili_ca(policy)
        original_init(agent, *args, **kwargs)
        try:
            ensure_bili_agent(agent, policy)
        except Exception:
            close = getattr(agent, "close", None)
            if callable(close):
                close()
            raise

    def guard_method(original: Any, after: bool):
        @wraps(original)
        def guarded(agent: Any, *args: Any, **kwargs: Any):
            if after:
                bind_bili_ca(policy)
            else:
                ensure_bili_agent(agent, policy)
            result = original(agent, *args, **kwargs)
            if after:
                ensure_bili_agent(agent, policy)
            return result
        return guarded

    # Future upstream delegate constructors import this same class. Never give
    # children the parent's ID or patch files in the Hermes installation.
    agent_class.__init__ = initialize
    for name in ("run_conversation", "switch_model", "_swap_credential"):
        original = getattr(agent_class, name, None)
        if callable(original):
            setattr(agent_class, name, guard_method(original, name in {"switch_model", "_swap_credential"}))
    def guard_api_method(original: Any):
        @wraps(original)
        def guarded(agent: Any, api_kwargs: dict[str, Any], *args: Any, **kwargs: Any):
            ensure_bili_agent(agent, policy)
            return original(agent, _bili_request_kwargs(agent, api_kwargs), *args, **kwargs)
        return guarded
    for name in ("_interruptible_api_call", "_interruptible_streaming_api_call"):
        original = getattr(agent_class, name, None)
        if callable(original):
            setattr(agent_class, name, guard_api_method(original))
    original_codex_stream = getattr(agent_class, "_run_codex_stream", None)
    if callable(original_codex_stream):
        @wraps(original_codex_stream)
        def codex_stream(agent: Any, api_kwargs: dict[str, Any], client: Any = None, on_first_delta: Any = None):
            ensure_bili_agent(agent, policy)
            if getattr(agent, "api_mode", None) != "codex_responses":
                raise RuntimeError("bili cannot verify Responses for this provider transport")
            # Hermes may use a request-local SDK instead of agent.client. Resolve
            # its fallback once and pass the exact verified client to the sender.
            active_client = client or agent._ensure_primary_openai_client(reason="codex_stream_direct")
            verify_bili_transport(agent, policy, sdk=active_client)
            return original_codex_stream(agent, _bili_request_kwargs(agent, api_kwargs),
                                         client=active_client, on_first_delta=on_first_delta)
        agent_class._run_codex_stream = codex_stream
    agent_class._bridge_bili_worker_binding = binding


def install_bili_compression_guard(agent: Any, session_id: str) -> None:
    if getattr(agent, "session_id", session_id) != session_id:
        raise RuntimeError("bili conversation identity must equal the Studio session ID")
    agent.compression_enabled = False
    agent.codex_responses_native_compaction = False
    agent.codex_app_server_auto_compaction = False
    compressor = getattr(agent, "context_compressor", None)
    if compressor is not None:
        compressor._micro_compact_enabled = False
    def reject_native_compression(*args: Any, **kwargs: Any):
        raise RuntimeError("bili owns this conversation; native compression and session rotation are disabled")
    agent._compress_context = reject_native_compression


def compact_session(owner: dict[str, Any], session_id: str) -> dict[str, Any]:
    if owner.get("manager") != "bili" or owner.get("conversationId") != session_id:
        raise RuntimeError("bili compact requires the exact session-owned conversation")
    origin = owner["proxyUrl"]
    manifest = public_request(origin, "/__bili/plugin/manifest")
    validate_manifest(manifest)
    # The compact HTTP endpoint notifies host rewrites, it does not request
    # compression. Invoke only an advertised argument-free public compact tool.
    tool_name = "compact"
    tool = next((tool for tool in manifest["tools"]["anthropic"] if isinstance(tool, dict) and tool.get("name") == tool_name), None)
    if tool_name not in manifest["toolNames"] or tool is None or tool["input_schema"].get("required"):
        raise RuntimeError("bili has no public session compact tool; use its compression tools with explicit arguments")
    result = public_request(origin, "/__bili/plugin/tool", {"conversationId": session_id, "tool": tool_name, "args": {}})
    if result.get("conversationId", session_id) != session_id:
        raise RuntimeError("bili public tool returned a different conversation identity")
    payload = result.get("result")
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except ValueError:
            pass
    if isinstance(payload, dict) and (payload.get("error") or payload.get("ok") is False):
        raise RuntimeError("bili public compact tool failed")
    status = public_request(origin, "/__bili/plugin/status?conversationId=" + quote(session_id, safe=""))
    if status.get("conversationId") != session_id or status.get("fallback") is True:
        raise RuntimeError("bili compact status did not verify the exact conversation")
    return {"manager": "bili", "owner": "bili", "conversationId": session_id, "proxyUrl": origin, "context_manager": owner, "result": result, "status": status}
