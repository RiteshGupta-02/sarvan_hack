import base64
import json
import mimetypes
import os
import re
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse


ROOT = Path(__file__).resolve().parent
DATA_FILE = Path(os.environ.get("UDHAAROS_DATA_FILE", ROOT / "data" / "ledger.json"))
MAX_JSON_BODY = 12 * 1024 * 1024
ledger_lock = threading.RLock()
ALLOWED_INTENTS = {
    "add_credit", "record_payment", "get_balance", "get_customer_history",
    "get_customer_stats", "get_profit", "record_expense", "add_customer",
    "list_customers", "list_top_debtors", "get_summary", "clarify", "unknown", "chat",
}
SUPPORTED_LANGUAGES = {
    "hi-IN", "bn-IN", "ta-IN", "te-IN", "kn-IN", "ml-IN",
    "mr-IN", "gu-IN", "pa-IN", "od-IN", "en-IN",
}


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def load_env():
    env_file = ROOT / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        name = name.strip()
        value = value.strip().strip("'\"")
        if name and name not in os.environ:
            os.environ[name] = value


def read_ledger():
    return read_ledger_for("main")


def read_ledger_for(dataset):
    if dataset not in ("main", "sample"):
        raise ApiError(400, "Unknown ledger dataset.")
    data_file = DATA_FILE if dataset == "main" else DATA_FILE.with_name("sample-ledger.json")
    with ledger_lock:
        if not data_file.exists():
            if dataset == "sample":
                ledger = create_sample_ledger()
                save_ledger_for(ledger, dataset)
                return ledger
            return {"customers": [], "transactions": [], "expenses": []}
        try:
            ledger = json.loads(data_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ApiError(500, "Could not read the local ledger file.") from error
        if not isinstance(ledger, dict) or not isinstance(ledger.get("customers"), list) or not isinstance(ledger.get("transactions"), list):
            raise ApiError(500, "The local ledger file has an invalid format.")
        ledger.setdefault("expenses", [])
        return ledger


def save_ledger(ledger, dataset="main"):
    save_ledger_for(ledger, dataset)


def save_ledger_for(ledger, dataset):
    if dataset not in ("main", "sample"):
        raise ApiError(400, "Unknown ledger dataset.")
    data_file = DATA_FILE if dataset == "main" else DATA_FILE.with_name("sample-ledger.json")
    with ledger_lock:
        try:
            data_file.parent.mkdir(parents=True, exist_ok=True)
            temporary = data_file.with_suffix(".json.tmp")
            temporary.write_text(json.dumps(ledger, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(temporary, data_file)
        except OSError as error:
            raise ApiError(500, "Could not save the local ledger file.") from error


def create_sample_ledger():
    now = datetime.now(timezone.utc)
    customers = [
        {"id": "sample-ramesh", "name": "Sample Ramesh Kumar", "phone": "", "createdAt": (now - timedelta(days=20)).isoformat()},
        {"id": "sample-sita", "name": "Sample Sita Devi", "phone": "", "createdAt": (now - timedelta(days=14)).isoformat()},
        {"id": "sample-aman", "name": "Sample Aman Singh", "phone": "", "createdAt": (now - timedelta(days=7)).isoformat()},
    ]
    transactions = [
        {"id": str(uuid.uuid4()), "customerId": "sample-ramesh", "type": "credit", "amountPaise": 250000, "costPaise": 165000, "description": "Sample grocery credit", "createdAt": (now - timedelta(days=4)).isoformat()},
        {"id": str(uuid.uuid4()), "customerId": "sample-ramesh", "type": "payment", "amountPaise": 100000, "description": "Sample part payment", "createdAt": (now - timedelta(days=2)).isoformat()},
        {"id": str(uuid.uuid4()), "customerId": "sample-sita", "type": "credit", "amountPaise": 80000, "costPaise": 50000, "description": "Sample household items", "createdAt": (now - timedelta(days=6)).isoformat()},
        {"id": str(uuid.uuid4()), "customerId": "sample-sita", "type": "payment", "amountPaise": 120000, "description": "Sample advance payment", "createdAt": (now - timedelta(days=1)).isoformat()},
        {"id": str(uuid.uuid4()), "customerId": "sample-aman", "type": "credit", "amountPaise": 125000, "costPaise": None, "description": "Sample shop credit; cost not entered", "createdAt": (now - timedelta(days=3)).isoformat()},
    ]
    return {
        "customers": customers,
        "transactions": transactions,
        "expenses": [
            {"id": str(uuid.uuid4()), "amountPaise": 15000, "description": "Sample shop electricity", "createdAt": (now - timedelta(days=2)).isoformat()},
        ],
    }


def balance_for(ledger, customer_id):
    return sum(
        tx["amountPaise"] if tx["type"] == "credit" else -tx["amountPaise"]
        for tx in ledger["transactions"] if tx["customerId"] == customer_id
    )


def require_api_key():
    key = os.environ.get("SARVAM_API_KEY") or os.environ.get("API_KEY")
    if not key:
        raise ApiError(503, "Add SARVAM_API_KEY=your_key to the .env file, then restart the app.")
    return key


def sarvam_request(path, payload, api_key, timeout=30):
    request = urllib.request.Request(
        "https://api.sarvam.ai" + path,
        data=payload,
        headers={"Content-Type": "application/json", "api-subscription-key": api_key},
        method="POST",
    )
    last_error = None
    for attempt in range(2):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            if attempt == 0 and error.code in (408, 429, 500, 502, 503, 504):
                time.sleep(0.5)
                continue
            if error.code == 429:
                raise ApiError(429, "Sarvam is busy. Please wait a moment and retry.") from error
            raise ApiError(502, "Sarvam could not complete the request. Check your API key and try again.") from error
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            last_error = error
            if attempt == 0:
                time.sleep(0.5)
                continue
    raise ApiError(502, "Sarvam could not be reached. Check your internet connection and retry.") from last_error


def parse_intent(content):
    match = re.search(r"\{[\s\S]*\}", content)
    if not match:
        raise ApiError(502, "Sarvam returned an unclear reply. Please try again.")
    try:
        intent = json.loads(match.group(0))
    except json.JSONDecodeError as error:
        raise ApiError(502, "Sarvam returned an unclear reply. Please try again.") from error
    if not isinstance(intent, dict) or intent.get("intent") not in ALLOWED_INTENTS:
        raise ApiError(502, "Sarvam returned an unsupported request. Please try again.")
    amount = intent.get("amount_paise")
    if amount is not None and (isinstance(amount, bool) or not isinstance(amount, int) or amount <= 0):
        raise ApiError(502, "Sarvam returned an invalid amount. Please try again.")
    cost = intent.get("cost_paise")
    if cost is not None and (isinstance(cost, bool) or not isinstance(cost, int) or cost < 0):
        raise ApiError(502, "Sarvam returned an invalid item cost. Please try again.")
    return {
        "intent": intent["intent"],
        "customer_name": intent.get("customer_name")[:80] if isinstance(intent.get("customer_name"), str) else None,
        "amount_paise": amount,
        "cost_paise": cost,
        "description": intent.get("description")[:120] if isinstance(intent.get("description"), str) else None,
        "needs_clarification": intent.get("needs_clarification") is True,
        "reply": intent.get("reply")[:300] if isinstance(intent.get("reply"), str) else None,
    }


def agent_reply(body):
    message = body.get("message")
    if not isinstance(message, str) or not message.strip() or len(message) > 500:
        raise ApiError(400, "Message is required and must be under 500 characters.")
    history = body.get("history", [])
    if not isinstance(history, list):
        history = []
    history = [
        {"role": turn["role"], "content": turn["content"]}
        for turn in history[-6:]
        if isinstance(turn, dict)
        and turn.get("role") in ("user", "assistant")
        and isinstance(turn.get("content"), str)
        and len(turn["content"]) <= 500
    ]
    dataset = body.get("dataset", "main")
    ledger = read_ledger_for(dataset)
    customer_names = [customer["name"] for customer in ledger["customers"][:100]]
    system = (
        "You are UdhaarOS, the shop owner's friendly, proactive Hindi/Hinglish/English business buddy. "
        "Be warm, concise, practical, and respond naturally to greetings or general shop questions. "
        "Never invent ledger facts, balances, costs, or profit. "
        "Interpret the LATEST user message and return exactly one JSON object:\n"
        '{"intent":"add_customer|add_credit|record_payment|record_expense|get_balance|get_customer_history|get_customer_stats|get_profit|list_customers|list_top_debtors|get_summary|chat|clarify|unknown",'
        '"customer_name":string|null,"amount_paise":integer|null,"cost_paise":integer|null,"description":string|null,'
        '"needs_clarification":boolean,"reply":string|null}\n'
        "Use recent conversation only to understand a direct answer to your own clarification question. "
        "Never repeat an operation from an earlier user message. A customer takes goods on credit => add_credit. "
        "A customer gives money to the shop => record_payment. Convert rupees to integer paise (₹1 = 100). "
        "When asked to add/create a customer, use add_customer and put only their name in customer_name. "
        "When asked to record a shop expense, use record_expense. Asking for profit => get_profit. "
        "A per-customer detailed report => get_customer_stats. For an add_credit request, provide cost_paise "
        "only if the user explicitly gives the goods' purchase cost; otherwise use null. "
        "Never infer a missing amount, customer, or transaction direction. Ask one short, specific question "
        "in the user's language when unclear. For customer lookups/transactions use exact names from this list; "
        "a new name is allowed for add_customer, add_credit, or record_payment; for a credit/payment "
        "with a new name, return that exact customer_name and the UI will create the customer before "
        "saving the entry. Do not invent names or create customers for lookups: "
        f"{json.dumps(customer_names, ensure_ascii=False)}; if more than one could match, clarify. "
        "For balance/history/top debtor/summary/profit requests, return the appropriate intent; do not calculate "
        "or state any ledger totals. General shop advice or chat should use chat and a helpful reply. Output JSON only."
    )
    messages = [{"role": "system", "content": system}, *history, {"role": "user", "content": message.strip()}]
    result = sarvam_request(
        "/v1/chat/completions",
        json.dumps({"model": "sarvam-105b-conversations", "messages": messages, "temperature": 0, "max_tokens": 500}).encode(),
        require_api_key(),
        timeout=25,
    )
    try:
        content = result["choices"][0]["message"]["content"]
        if isinstance(content, list):
            content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
        if not isinstance(content, str) or not content.strip():
            raise ValueError("empty response")
        return parse_intent(content)
    except (KeyError, IndexError, TypeError, ValueError) as error:
        if isinstance(error, ApiError):
            raise
        raise ApiError(502, "Sarvam returned an empty reply. Please try again.") from error


def create_customer(body, dataset="main"):
    name = body.get("name", "").strip() if isinstance(body.get("name"), str) else ""
    phone = body.get("phone", "").strip() if isinstance(body.get("phone"), str) else ""
    if not name or len(name) > 80:
        raise ApiError(400, "Customer name must be 1–80 characters.")
    if len(phone) > 20:
        raise ApiError(400, "Phone number must be under 20 characters.")
    request_id = body.get("requestId")
    if request_id is None:
        request_id = str(uuid.uuid4())
    elif not isinstance(request_id, str) or not re.fullmatch(r"[0-9a-f-]{36}", request_id, re.I):
        raise ApiError(400, "Customer request ID is invalid.")
    with ledger_lock:
        ledger = read_ledger_for(dataset)
        existing = next((customer for customer in ledger["customers"] if customer["id"] == request_id), None)
        if existing:
            if existing["name"] != name or existing["phone"] != phone:
                raise ApiError(409, "This customer request was already used with different details.")
            return {"customer": existing, **ledger}
        if any(customer["name"].casefold() == name.casefold() for customer in ledger["customers"]):
            raise ApiError(409, "A customer with this name already exists.")
        customer = {"id": request_id, "name": name, "phone": phone, "createdAt": datetime.now(timezone.utc).isoformat()}
        ledger["customers"].append(customer)
        save_ledger(ledger, dataset)
        return {"customer": customer, **ledger}


def create_transaction(body):
    customer_id = body.get("customerId")
    kind = body.get("type")
    amount = body.get("amountPaise")
    request_id = body.get("requestId")
    if not isinstance(customer_id, str) or not re.fullmatch(r"[\w-]{1,80}", customer_id):
        raise ApiError(400, "Choose a valid customer.")
    if kind not in ("credit", "payment"):
        raise ApiError(400, "Choose credit or payment.")
    if isinstance(amount, bool) or not isinstance(amount, int) or not 0 < amount <= 100_000_000_000:
        raise ApiError(400, "Enter a valid positive amount.")
    if not isinstance(request_id, str) or not re.fullmatch(r"[0-9a-f-]{36}", request_id, re.I):
        raise ApiError(400, "Transaction request ID is invalid.")
    description = body.get("description", "")
    description = description.strip()[:120] if isinstance(description, str) else ""
    cost = body.get("costPaise")
    if cost is not None and (isinstance(cost, bool) or not isinstance(cost, int) or not 0 <= cost <= 100_000_000_000):
        raise ApiError(400, "Enter a valid cost amount.")
    if kind == "payment":
        cost = None
    dataset = body.get("dataset", "main")

    with ledger_lock:
        ledger = read_ledger_for(dataset)
        existing = next((tx for tx in ledger["transactions"] if tx["id"] == request_id), None)
        if existing:
            if existing["customerId"] != customer_id or existing["type"] != kind or existing["amountPaise"] != amount:
                raise ApiError(409, "This transaction request was already used. Refresh the ledger and try again.")
            return {"transaction": existing, "balancePaise": balance_for(ledger, customer_id), **ledger}
        customer = next((item for item in ledger["customers"] if item["id"] == customer_id), None)
        if not customer:
            raise ApiError(404, "Customer not found. Refresh the ledger and try again.")
        transaction = {
            "id": request_id, "customerId": customer_id, "type": kind,
            "amountPaise": amount, "costPaise": cost if kind == "credit" else None,
            "description": description,
            "createdAt": datetime.now(timezone.utc).isoformat(),
        }
        ledger["transactions"].append(transaction)
        save_ledger(ledger, dataset)
        return {"transaction": transaction, "balancePaise": balance_for(ledger, customer_id), **ledger}


def create_expense(body, dataset="main"):
    amount = body.get("amountPaise")
    description = body.get("description", "")
    if isinstance(amount, bool) or not isinstance(amount, int) or not 0 < amount <= 100_000_000_000:
        raise ApiError(400, "Enter a valid positive expense amount.")
    if not isinstance(description, str) or not description.strip():
        raise ApiError(400, "Add a short description for the expense.")
    request_id = body.get("requestId")
    if not isinstance(request_id, str) or not re.fullmatch(r"[0-9a-f-]{36}", request_id, re.I):
        raise ApiError(400, "Expense request ID is invalid.")
    expense = {
        "id": request_id,
        "amountPaise": amount,
        "description": description.strip()[:120],
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    with ledger_lock:
        ledger = read_ledger_for(dataset)
        existing = next((item for item in ledger["expenses"] if item["id"] == request_id), None)
        if existing:
            if existing["amountPaise"] != amount or existing["description"] != description.strip()[:120]:
                raise ApiError(409, "This expense request was already used with different details.")
            return {"expense": existing, **ledger}
        ledger["expenses"].append(expense)
        save_ledger(ledger, dataset)
        return {"expense": expense, **ledger}


def transcribe(body):
    encoded = body.get("audioBase64")
    if not isinstance(encoded, str) or len(encoded) > 8 * 1024 * 1024:
        raise ApiError(400, "Audio recording is missing or too large. Please try a shorter recording.")
    try:
        audio = base64.b64decode(encoded, validate=True)
    except ValueError as error:
        raise ApiError(400, "Invalid audio recording. Please record again.") from error
    if not audio or len(audio) > 6 * 1024 * 1024:
        raise ApiError(400, "Audio recording is missing or too large. Please try a shorter recording.")
    audio_type = body.get("audioType", "audio/webm").split(";")[0]
    if audio_type not in {"audio/webm", "audio/mp4", "audio/ogg", "audio/wav", "audio/mpeg"}:
        audio_type = "audio/webm"
    filename = body.get("filename", "recording.webm")
    if not isinstance(filename, str) or not re.fullmatch(r"[\w.-]{1,80}", filename):
        filename = "recording.webm"
    boundary = "----UdhaarOS" + uuid.uuid4().hex
    fields = [
        ("file", filename, audio_type, audio),
        ("model", None, None, b"saaras:v4"),
        ("language_code", None, None, b"unknown"),
    ]
    dataset = body.get("dataset", "main")
    names = [customer["name"][:64] for customer in read_ledger_for(dataset)["customers"][:50]]
    if names:
        fields.append(("keyterms", None, None, json.dumps(names, ensure_ascii=False).encode()))
    parts = []
    for field_name, field_filename, content_type, value in fields:
        disposition = f'Content-Disposition: form-data; name="{field_name}"'
        if field_filename:
            disposition += f'; filename="{field_filename}"'
        headers = [disposition]
        if content_type:
            headers.append(f"Content-Type: {content_type}")
        parts.append(b"--" + boundary.encode() + b"\r\n" + "\r\n".join(headers).encode() + b"\r\n\r\n" + value + b"\r\n")
    request = urllib.request.Request(
        "https://api.sarvam.ai/speech-to-text",
        data=b"".join(parts) + b"--" + boundary.encode() + b"--\r\n",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}", "api-subscription-key": require_api_key()},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=35) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raise ApiError(502, "Sarvam could not transcribe this recording. Please try again.") from error
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        raise ApiError(502, "Audio could not be processed. Check your connection and try again.") from error
    transcript = result.get("transcript")
    if not isinstance(transcript, str) or not transcript.strip():
        raise ApiError(422, "I could not hear any words. Please try speaking a little louder.")
    return {"transcript": transcript[:500], "languageCode": result.get("language_code")}


def speak(body):
    text = body.get("text")
    language = body.get("languageCode")
    if not isinstance(text, str) or not text.strip() or len(text) > 500:
        raise ApiError(400, "Speech text must be between 1 and 500 characters.")
    if language not in SUPPORTED_LANGUAGES:
        raise ApiError(400, "Spoken replies are not available for this language yet.")
    result = sarvam_request(
        "/text-to-speech",
        json.dumps({"text": text.strip(), "language_code": language, "model": "bulbul:v3", "speaker": "shubh"}).encode(),
        require_api_key(),
        timeout=25,
    )
    audios = result.get("audios")
    if not isinstance(audios, list) or not all(isinstance(audio, str) for audio in audios):
        raise ApiError(502, "Sarvam returned invalid speech audio.")
    return {"audio": "".join(audios), "languageCode": language}


class AppHandler(BaseHTTPRequestHandler):
    server_version = "UdhaarOSLocal/1.0"

    def send_json(self, status, body):
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ApiError(400, "Invalid request size.") from error
        if length <= 0 or length > MAX_JSON_BODY:
            raise ApiError(413, "Request is empty or too large.")
        try:
            body = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise ApiError(400, "Invalid JSON request.") from error
        if not isinstance(body, dict):
            raise ApiError(400, "Invalid request.")
        return body

    def do_GET(self):
        parsed_url = urlparse(self.path)
        path = unquote(parsed_url.path)
        if path == "/.netlify/functions/ledger":
            try:
                dataset = parse_qs(parsed_url.query).get("dataset", ["main"])[0]
                self.send_json(200, read_ledger_for(dataset))
            except ApiError as error:
                self.send_json(error.status, {"error": str(error)})
            return
        assets = {"/": "index.html", "/index.html": "index.html", "/app.js": "app.js", "/styles.css": "styles.css"}
        filename = assets.get(path)
        if not filename:
            self.send_error(404)
            return
        file_path = ROOT / filename
        try:
            content = file_path.read_bytes()
        except OSError:
            self.send_error(404)
            return
        content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8" if content_type.startswith("text/") or content_type in ("application/javascript",) else content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(content)

    def do_POST(self):
        path = urlparse(self.path).path
        actions = {
            "/.netlify/functions/agent": agent_reply,
            "/.netlify/functions/speak": speak,
            "/.netlify/functions/transcribe": transcribe,
        }
        try:
            body = self.read_json()
            if path == "/.netlify/functions/ledger":
                action = body.get("action")
                dataset = body.get("dataset", "main")
                if action == "create_customer":
                    self.send_json(201, create_customer(body, dataset))
                elif action == "create_transaction":
                    self.send_json(200, create_transaction(body))
                elif action == "create_expense":
                    self.send_json(201, create_expense(body, dataset))
                else:
                    raise ApiError(400, "Unsupported ledger action.")
                return
            handler = actions.get(path)
            if not handler:
                self.send_error(404)
                return
            self.send_json(200, handler(body))
        except ApiError as error:
            self.send_json(error.status, {"error": str(error)})
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as error:
            print(f"Local request failed: {error}")
            self.send_json(500, {"error": "The local app could not complete that request. Please retry."})

    def log_message(self, format_string, *args):
        print(f"{self.log_date_time_string()} {self.address_string()} {format_string % args}")


def main():
    load_env()
    server = ThreadingHTTPServer(("127.0.0.1", 8765), AppHandler)
    print("UdhaarOS is running on http://127.0.0.1:8765")
    print("Ledger file:", DATA_FILE)
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping UdhaarOS.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
