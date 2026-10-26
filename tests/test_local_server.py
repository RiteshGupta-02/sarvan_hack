import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import server


class LocalLedgerApiTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_data_file = server.DATA_FILE
        server.DATA_FILE = Path(self.temp_dir.name) / "ledger.json"
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.AppHandler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join()
        server.DATA_FILE = self.original_data_file
        self.temp_dir.cleanup()

    def request_json(self, path, payload=None):
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = urllib.request.Request(
            self.base_url + path,
            data=data,
            headers={"Content-Type": "application/json"} if data else {},
            method="POST" if data else "GET",
        )
        try:
            with urllib.request.urlopen(request) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            body = json.loads(error.read())
            error.close()
            return error.code, body

    def test_customer_creation_and_duplicate_error(self):
        status, created = self.request_json(
            "/.netlify/functions/ledger",
            {
                "action": "create_customer",
                "name": "Anita Sharma",
                "phone": "",
                "requestId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            },
        )

        self.assertEqual(status, 201)
        self.assertEqual(created["customer"]["name"], "Anita Sharma")
        self.assertEqual(len(created["customers"]), 1)
        retry_status, retried = self.request_json(
            "/.netlify/functions/ledger",
            {
                "action": "create_customer",
                "name": "Anita Sharma",
                "phone": "",
                "requestId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            },
        )
        self.assertEqual(retry_status, 201)
        self.assertEqual(retried["customer"]["id"], created["customer"]["id"])

        duplicate_status, duplicate = self.request_json(
            "/.netlify/functions/ledger",
            {"action": "create_customer", "name": "ANITA SHARMA", "phone": ""},
        )
        self.assertEqual(duplicate_status, 409)
        self.assertIn("already exists", duplicate["error"])
        self.assertEqual(len(server.read_ledger()["customers"]), 1)

    def test_credit_cost_advance_and_expense(self):
        _, created = self.request_json(
            "/.netlify/functions/ledger",
            {"action": "create_customer", "name": "Sita Devi", "phone": ""},
        )
        customer_id = created["customer"]["id"]
        status, sale = self.request_json(
            "/.netlify/functions/ledger",
            {
                "action": "create_transaction",
                "customerId": customer_id,
                "type": "credit",
                "amountPaise": 10000,
                "costPaise": 5000,
                "description": "Groceries",
                "requestId": "11111111-1111-4111-8111-111111111111",
            },
        )
        self.assertEqual(status, 200)
        self.assertEqual(sale["transaction"]["costPaise"], 5000)

        status, payment = self.request_json(
            "/.netlify/functions/ledger",
            {
                "action": "create_transaction",
                "customerId": customer_id,
                "type": "payment",
                "amountPaise": 15000,
                "requestId": "22222222-2222-4222-8222-222222222222",
            },
        )
        self.assertEqual(status, 200)
        self.assertEqual(payment["balancePaise"], -5000)

        status, expense = self.request_json(
            "/.netlify/functions/ledger",
            {
                "action": "create_expense",
                "amountPaise": 1000,
                "description": "Electricity",
                "requestId": "33333333-3333-4333-8333-333333333333",
            },
        )
        self.assertEqual(status, 201)
        self.assertEqual(expense["expenses"][0]["description"], "Electricity")
        _, duplicate_expense = self.request_json(
            "/.netlify/functions/ledger",
            {
                "action": "create_expense",
                "amountPaise": 1000,
                "description": "Electricity",
                "requestId": "33333333-3333-4333-8333-333333333333",
            },
        )
        self.assertEqual(len(duplicate_expense["expenses"]), 1)

        ledger = server.read_ledger()
        sales = sum(tx["amountPaise"] for tx in ledger["transactions"] if tx["type"] == "credit")
        costs = sum(tx["costPaise"] for tx in ledger["transactions"] if tx["type"] == "credit")
        expenses = sum(item["amountPaise"] for item in ledger["expenses"])
        self.assertEqual(sales - costs - expenses, 4000)

    def test_sample_ledger_is_separate_and_includes_advance(self):
        _, created = self.request_json(
            "/.netlify/functions/ledger",
            {"action": "create_customer", "name": "Real Ledger Customer", "phone": ""},
        )
        self.assertEqual(len(created["customers"]), 1)

        sample_status, sample = self.request_json("/.netlify/functions/ledger?dataset=sample")
        self.assertEqual(sample_status, 200)
        self.assertEqual(len(sample["customers"]), 3)
        self.assertTrue(all(customer["name"].startswith("Sample ") for customer in sample["customers"]))
        sita = next(customer for customer in sample["customers"] if customer["name"] == "Sample Sita Devi")
        self.assertLess(server.balance_for(sample, sita["id"]), 0)

        main_status, main = self.request_json("/.netlify/functions/ledger")
        self.assertEqual(main_status, 200)
        self.assertEqual([customer["name"] for customer in main["customers"]], ["Real Ledger Customer"])

    def test_agent_intent_parser_accepts_shopkeeper_actions(self):
        for intent in ("add_customer", "record_expense", "get_profit", "get_customer_stats", "chat"):
            with self.subTest(intent=intent):
                result = server.parse_intent(json.dumps({
                    "intent": intent,
                    "customer_name": "Sita Devi",
                    "amount_paise": None,
                    "cost_paise": None,
                    "description": None,
                    "needs_clarification": False,
                    "reply": "Hello",
                }))
                self.assertEqual(result["intent"], intent)

    def test_agent_allows_new_customer_for_credit_or_payment(self):
        response = {
            "choices": [{
                "message": {
                    "content": json.dumps({
                        "intent": "add_credit",
                        "customer_name": "Ajay Kumar",
                        "amount_paise": 12500,
                        "cost_paise": None,
                        "description": "Samaan",
                        "needs_clarification": False,
                        "reply": None,
                    })
                }
            }]
        }
        with patch.object(server, "require_api_key", return_value="mocked-key"), patch.object(
            server, "sarvam_request", return_value=response
        ) as sarvam_request:
            result = server.agent_reply({"message": "Ajay Kumar ne 125 rupaye ka samaan udhaar liya"})

        prompt = json.loads(sarvam_request.call_args.args[1])["messages"][0]["content"]
        self.assertEqual(result["intent"], "add_credit")
        self.assertIn("a new name is allowed for add_customer, add_credit, or record_payment", prompt)
        self.assertIn("create customers for lookups", prompt)


if __name__ == "__main__":
    unittest.main()
