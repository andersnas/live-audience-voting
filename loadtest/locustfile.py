"""
Locust load test for live-audience-voting.

Simulates human-like voter behavior:
1. Load voter URL
2. Register with a unique email
3. Poll /api/question every 3s (matches real voter UI)
4. When question is active: "think" 3-10s, then vote
5. Keep polling; vote again when admin activates a new question

Run:
    SET_ID=<your-set-id> locust -f locustfile.py \\
        --host https://{CDN_HOSTNAME} \\
        --users 300 --spawn-rate 5

Then open http://localhost:8089 for the web UI, or add --headless for CLI.
"""

import os
import random
import time
import uuid

from locust import HttpUser, task, between, events


SET_ID = os.environ.get("SET_ID")
BASE = "/voterapp"

if not SET_ID:
    raise RuntimeError("SET_ID environment variable is required")


class Voter(HttpUser):
    # Time between tasks (polling cycle)
    wait_time = between(2.5, 3.5)

    def on_start(self):
        """Called once per simulated user at spawn time."""
        self.jwt = None
        self.current_question_id = None
        self.voted_question_ids = set()
        self.last_vote_time = 0

        # Load the voter HTML page (realistic first request)
        self.client.get(
            f"{BASE}/?set={SET_ID}",
            name="GET /voterapp/?set=...",
        )

        # Simulate user reading + typing email (2-5s)
        time.sleep(random.uniform(2, 5))

        # Register with unique email
        email = f"loadtest_{uuid.uuid4().hex[:12]}@example.com"
        with self.client.post(
            f"{BASE}/api/voter/register",
            json={"email": email, "setId": SET_ID},
            name="POST /api/voter/register",
            catch_response=True,
        ) as res:
            if res.status_code != 200:
                res.failure(f"Register failed: {res.status_code}")
                return
            data = res.json()
            self.jwt = data.get("jwt")
            if not self.jwt:
                res.failure("No JWT in register response")
                return
            # If registration already returned an active question, process it
            q = data.get("question")
            if q:
                self.current_question_id = q["id"]
                self._maybe_vote(q)

    @task
    def poll_and_vote(self):
        """Called repeatedly. Polls for active question and votes if new."""
        if not self.jwt:
            return

        with self.client.get(
            f"{BASE}/api/question?set={SET_ID}",
            headers={"Authorization": f"Bearer {self.jwt}"},
            name="GET /api/question",
            catch_response=True,
        ) as res:
            if res.status_code != 200:
                res.failure(f"Poll failed: {res.status_code}")
                return

            data = res.json()
            question = data.get("question")

            if not question:
                # No active question — nothing to do, loop again after wait_time
                return

            qid = question["id"]
            if qid != self.current_question_id:
                self.current_question_id = qid

            self._maybe_vote(question)

    def _maybe_vote(self, question):
        """Vote on the question if we haven't already."""
        qid = question["id"]
        if qid in self.voted_question_ids:
            return

        # Simulate thinking time (3-10s)
        time.sleep(random.uniform(3, 10))

        options = question.get("options", [])
        if not options:
            return
        choice = random.choice(options)

        with self.client.post(
            f"{BASE}/api/vote",
            json={"option": choice["key"], "setId": SET_ID},
            headers={"Authorization": f"Bearer {self.jwt}"},
            name="POST /api/vote",
            catch_response=True,
        ) as res:
            if res.status_code != 200:
                res.failure(f"Vote failed: {res.status_code}")
                return
            self.voted_question_ids.add(qid)
            self.last_vote_time = time.time()


@events.test_start.add_listener
def on_test_start(environment, **kwargs):
    print(f"\n=== Load test starting ===")
    print(f"Set ID: {SET_ID}")
    print(f"Host: {environment.host}")
    print(f"Users: {environment.runner.target_user_count if environment.runner else '?'}")
    print(f"Activate questions from the admin UI to trigger vote rounds.\n")


@events.test_stop.add_listener
def on_test_stop(environment, **kwargs):
    stats = environment.stats.total
    print(f"\n=== Load test finished ===")
    print(f"Total requests: {stats.num_requests}")
    print(f"Failures: {stats.num_failures} ({stats.fail_ratio * 100:.1f}%)")
    print(f"Median response: {stats.median_response_time} ms")
    print(f"95th percentile: {stats.get_response_time_percentile(0.95):.0f} ms")
    print(f"99th percentile: {stats.get_response_time_percentile(0.99):.0f} ms")
