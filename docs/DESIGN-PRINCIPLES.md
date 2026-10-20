# Locus design principles

These rules are decision tools, not slogans pasted on top of arbitrary code.

## 1. Model decides WHAT. Harness decides WHERE.

The model chooses an operation in familiar task terms. The harness chooses the backend, mount, relay, worker, provider adapter, or future escalation path.

## 2. Prefer execution close to data

For lightweight work, prefer local browser execution next to user-granted data, the least authority sufficient for the operation, the cheapest reliable backend, and explicit escalation only when the browser cannot faithfully complete the task.

## 3. Do not make the model learn Locus

Expose ordinary paths, a bounded Unix-like shell, and familiar library APIs. Internal objects such as CapabilityManager, OPFS, CSP creator iframes, and relay topology are harness concerns.

> 本条与 [CAPABILITY-BOUNDARIES §6.3](CAPABILITY-BOUNDARIES.md#63-mcp-authority) 之间的矛盾已由 [DECISIONS.md D4](DECISIONS.md#d4) 裁决：MCP 工具以 provider 原生工具形式暴露（任务边界冻结、排序确定、排在 bash 之后），不需要模型学习字符串化的 MCP shell 命令。

> 已被 [DECISIONS.md D4](DECISIONS.md#d4)（2026-10-18 改写）取代：MCP 通过 shell 命令 `mcp` 暴露。

## 4. Keep the core primitive set small

The browser substrate has four categories:

- Execution
- Filesystem
- Network
- Perception

A domain request does not become a new core primitive just because it is common.

> 本条与 [CAPABILITY-BOUNDARIES §6.3](CAPABILITY-BOUNDARIES.md#63-mcp-authority) 之间的矛盾已由 [DECISIONS.md D4](DECISIONS.md#d4) 裁决：MCP 工具以 provider 原生工具形式暴露，随 TaskEnvironment 在任务边界冻结、排序确定、排在 bash 之后；它们不是新的核心原语，本条“核心原语集合保持小”不受影响。

> 已被 [DECISIONS.md D4](DECISIONS.md#d4)（2026-10-18 改写）取代：MCP 通过 shell 命令 `mcp` 暴露。

## 5. Capability is the user abstraction

> Plugin adds code.  
> Skill adds knowledge.  
> MCP adds authority.  
> Capability composes them for the user.

## 6. Authority never expands silently

Execution placement may be transparent. Authority cannot.

A package does not inherit credentials. A relay does not inherit cookies. Approval does not make a read-only mount writable. Enabling a Capability does not connect MCP.

## 7. Snapshot task identity; allow explicit state mutation

A task freezes its `TaskEnvironment` identity at start. Files remain mutable within authority. SkillInstance mutation is special because it changes future agent behavior and therefore requires explicit confirmation.

## 8. Preserve provider semantics

Visible text is not the entire protocol. Provider-native continuation, reasoning, and tool-call state must survive when required.

## 9. Fail honestly

Do not claim rollback after a committed side effect. Do not retry ambiguous writes. Do not call a partial changeset complete. Do not collapse unknown into unsupported.

## 10. Evidence beats aesthetic architecture

Add abstraction because trajectories and tests show a need, not because a diagram has an empty box. Product capabilities should follow real user workflows after infrastructure contracts are stable.
