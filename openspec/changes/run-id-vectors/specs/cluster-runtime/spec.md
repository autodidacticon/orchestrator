## ADDED Requirements

### Requirement: Deploy notes state who the layout is for

`deploy/README.md` SHALL state, in a section before the image section, that the reference manifests are a single-user preview on kind, that the API takes no credential except the launch token, who reaches the API in the reference manifests, and that the Service is not to be exposed. It SHALL name the hardening milestone as the place authentication comes from.

#### Scenario: A reader looks for the API's exposure

- **WHEN** a reader opens `deploy/README.md`
- **THEN** a section before "Daemon image" says the layout is a single-user preview on kind, that only the six routes a worker calls read a credential (the launch token), that every pod in the cluster and every user who may port-forward into namespace `orch` reaches the API, that the Service must not be exposed through an Ingress, a NodePort or a LoadBalancer, and that authentication comes with the hardening milestone
