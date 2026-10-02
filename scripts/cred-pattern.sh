# cred-pattern.sh — the ONE definition of the credential SHAPE the shell leak-gates
# scan for: a HubSpot PAT (pat-<region>-<uuid>) or a PEM private-key header. Sourced
# by scripts/publish-sync.sh and scripts/credscan.sh so the two shell gates share a
# single copy (was duplicated). Sourced, not executed — it only sets CRED.
#
# A behaviourally-identical mirror lives in src/config/index.ts `CREDENTIAL_SHAPE`
# (TS runtime — rejects credential-shaped config keys/labels), separated from this
# copy by the TS<->POSIX boundary. The parity test in src/config/config.test.ts
# asserts the two agree, so drift fails CI rather than relying on a comment.
CRED='BEGIN [A-Z ]*PRIVATE KEY|pat-[a-z0-9]{2,4}-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
