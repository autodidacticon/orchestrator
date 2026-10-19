## 1. Probes

- [x] 1.1 Read opencode 1.18.30's `Wildcard.match` and bash command extraction; probe glob behaviour (X-glob-star, X-glob-escape, X-glob-bracket, X-glob-bracket-literal) and the split cases (X-subshell, X-subshell-missplit, X-ampersand, X-ampersand-whole, X-escaped-quote, X-redirect-text) with configs/probe-bash-rule.mjs

## 2. Implementation

- [x] 2.1 Split at a lone `&`, `|&`, `(` and `)`; keep redirection `&`/`|`, `$(...)` and escaped characters in the command; drop brace-group words
- [x] 2.2 Tests: the three reviewer inputs, `npm run lint & npm test` gives two patterns, redirections, substitutions, brace groups, glob characters copied verbatim

## 3. Spec

- [x] 3.1 worker-runners "OpenCode runner command composition": the splitting rules, the glob behaviour (no escape; `*` and `?` give a wildcard pattern; `[` literal), and three scenarios
