-- Worker job verification: track fact-checker results per job.
-- Added by the orchestrator-side fact-verifier (feature/orch-fact-verifier).
--
-- verification_status: 'pending' | 'clean' | 'quarantined' | 'skipped' | 'error'
--   pending   = awaiting verification
--   clean     = all claims verified or unverifiable (no contradictions)
--   quarantined = one or more CONTRADICTED claims, or empty result on completed job
--   skipped   = no claims found, nothing to check
--   error     = verifier itself errored (should be rare; daemon stays up)
--
-- verification_report: JSON blob with full per-claim results (ClaimResult[])
-- verification_flagged_at: ISO8601 UTC timestamp when quarantine was set

ALTER TABLE worker_jobs ADD COLUMN verification_status TEXT;
ALTER TABLE worker_jobs ADD COLUMN verification_report TEXT;
ALTER TABLE worker_jobs ADD COLUMN verification_flagged_at TEXT;
