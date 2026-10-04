# prose-pattern.sh — the ONE definition of the filler phrases the published prose may
# not contain. Sourced by scripts/prose-check.sh (which scans the published documents)
# and scripts/publish-sync.sh (which checks the public commit message), so the two
# gates share a single copy rather than drifting apart. Mirrors the arrangement in
# scripts/cred-pattern.sh.
#
# Sourced, not executed: it only sets FILLER.
#
# Each phrase was removed from these documents by hand. The list exists to stop them
# coming back, not to be exhaustive about bad writing.
FILLER='it is worth noting|worth noting that|needless to say|at the end of the day|in order to|leverage|utilize|seamless|robust|delve|deep dive|unlock the|game.chang|best.in.class|cutting.edge|revolutioniz|effortless|simply put|rest assured|we are excited|elevate your'

# Claims this server does not make. Published prose said "routes every ACTION to the
# portal you name" while the code says "reads may default; writes never do" (three tool
# descriptions in src/mcp/server.ts, and set_default_read_portal exists for exactly that
# fallback). USAGE.md contradicted itself inside one document: line 5 claimed it of every
# action, line 218 stated the real rule. The same sentence had propagated to the internal
# README and ARCHITECTURE, which is where the public prose was written from.
#
# It overclaims in the PERMISSIVE direction, which is the direction that misleads: a
# reader reasoning about where a read came from would conclude it was explicitly routed.
#
# What this does NOT cover: a claim that is TRUE but stated where the page cannot yet
# qualify it. "Every write is logged." was accurate and sat in line 7 of the README and
# line 3 of SAFETY, which then spend a section explaining that the log is not
# tamper-proof and not forensic evidence. That defect is POSITION, not wording, and a
# phrase list cannot see position. Banning the sentence would be wrong, since SAFETY.md
# states it legitimately under "What it protects". Both were found by the operator
# reading the page, which is still the only check for that half.
#
# The verb list grew once already. The first draft matched only "routes", and the v0.1.8
# release notes then turned up "sends every action to the portal you name" in their
# opening line. A pattern written from one instance knows one phrasing, so the fix is a
# verb alternation rather than a longer list of whole sentences.
OVERCLAIM='(routes|sends|directs) every (action|operation|call|read)|every (action|operation|call|read) (is|are) (routed|sent)|every (action|operation|call|read) names its portal|all (actions|operations|reads) are routed'

# Dates in published prose are ISO 8601 (2026-09-28). A long-form month with a day or a
# year beside it is rejected: "28 September 2026" and "September 28, 2026" read as
# different orders to different readers, and the internal notes already use ISO. A bare
# month name in a sentence is untouched, because it is not a date.
DATE_LONGFORM='[0-9]{1,2} (January|February|March|April|May|June|July|August|September|October|November|December) [0-9]{4}|(January|February|March|April|May|June|July|August|September|October|November|December) [0-9]{1,2},? [0-9]{4}'
