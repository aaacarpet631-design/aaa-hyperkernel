---
name: ads-simulation
description: Run efficient advertising sensitivity scenarios and retain reproducible lessons.
---

Search memory for previous assumptions and candidate lessons before repeating a simulation. Obtain budget, cost per click, conversion rate, close rate, and contribution profit per won job. If not supplied, ask for the missing inputs or explicitly label illustrative assumptions before using them. Rates are decimals from 0 to 1.

Call simulate_ads once for up to 100 scenarios, choosing and reporting a reproducible seed. This is an inexpensive arithmetic sensitivity analysis; it does not send 100 LLM requests or emulate Google's auction. CPC and conversion rate vary independently by ±20%; close rate varies by ±10%. It uses expected fractional jobs. These ranges are chosen assumptions, not fitted uncertainty estimates.

Compare mean, worst and best contribution after ad spend and the count of loss scenarios. Do not describe a scenario fraction as a real-world probability of loss. The tool automatically saves assumptions and summary results. Use remember_lesson only for additional candidate conclusions, with limitations and a proposed real-world validation. Never promote synthetic performance to proof, change ad spend, or imply that model weights were trained.

Produce a downloadable report with assumptions, method, results, lessons, and the next measurable test. Current Google Ads policies or API operations require current official sources through research or connected tools.
