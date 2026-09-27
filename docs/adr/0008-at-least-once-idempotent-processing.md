# ADR 0008: At-Least-Once, Idempotent Processing

## Context
Networks and webhook delivery cannot guarantee exactly-once delivery.

## Decision
Design for at-least-once ingestion with durable idempotent financial processing.

## Consequences
Retries/replays are safe; no false exactly-once claim is made.
