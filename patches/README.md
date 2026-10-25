# Paired and unqualified follow-up patches

`codex/provider-notice.patch` is for the separate customized Codex Native client, not this Web runtime. Its actual installed-client qualification remains separate.

`unqualified/43_ux_followup.patch` preserves the previously frozen R43 source/management candidate against its declared R42/130 baseline. It must not be reapplied wholesale to this newer145 tree: it contains overlapping owner13/14 changes and lacks real ChatGPT fault qualification and complete recovery-budget/multipart-writer behavior. It is archived here for version control only and is not applied or part of the production candidate.

This release branch preserves the exact isolated145 source lineage rooted in db43c8a. It does not merge the fork main branch: that branch has overlapping independent Mol185 recovery work, and a mechanical merge produced real conflicts. Main is untouched; integration is separate work, not an ours/theirs overwrite.
