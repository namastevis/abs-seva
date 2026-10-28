# Security review

**Method.** Cloudflare's [security-audit-skill](https://github.com/cloudflare/security-audit-skill), run as a **quick** profile on commit `6378202`, October 2026:

- Three independent reviewers looked at three areas:
  - the backend (`apps-script/Code.gs`)
  - the browser code (`docs/`)
  - deployment and the supply chain
- A fourth, separate verifier re-checked every finding against both the original and the fixed code, mostly with local proof-of-concept tests. It ran those against the built-in Sheets emulator, never the live service.
- The verifier also looked for problems the fixes themselves introduced.

**Coverage.** This was a condensed pass. Not every part of the skill's procedure was done:

- The skill's strict coverage ledger was not produced.
- A single verifier handled all the findings, instead of one per finding.

Treat it as a focused review, not exhaustive coverage.

## Fixed

| Severity | Issue | Fix |
|---|---|---|
| High | Stored XSS. A volunteer's "Other" ashram text, once added to the list, ran as script in admins' dashboards. | Escaping added. ID-card text is parsed safely. A Content-Security-Policy is set on `admin.html`. |
| High | Ashram-limited coordinators could take over other ashrams' groups and pull in any volunteer. | The group's own ashram is enforced, and the leader must be in scope. |
| Medium | Remarks could be added or deleted across ashrams, including the automatic history. | Ashram scope is enforced. Coordinators can delete only their own notes. |
| Medium | Volunteer numbers could be reused after a delete or merge, so an old edit link could control a stranger's record. | Numbers are never reused. Edit links are tied to the record and its mobile, and are never extended. |
| Medium | "Edit my registration" could be guessed with only a mobile number, and `check_mobile` revealed whether a number was registered. | `check_mobile` is removed. Attempts are limited per mobile and per number. |
| Medium | Unlimited anonymous registrations. | A global per-minute limit. The duplicate check is cached. A third registration on the same mobile is flagged for review. |
| Medium | A blank admin password was accepted, and there was no limit on login attempts. | Passwords must be at least 8 characters and are stored as salted hashes. Each username gets 10 tries per 15 minutes. |
| Low | Admin sessions survived a password change. | Sessions end when the password changes. Admins can change their own password from the dashboard. |
| Low | Unbounded "not the same person" requests, unscoped. | Capped, scope-checked, and written as one batch. |
| Low | Merging didn't check the ashram of the record being kept. | Scope check added. |
| Low | The pull-request CI job had Pages deploy permissions. | Least-privilege permissions per job. |
| Info | The old site's login stayed stored after the import. | It is removed when the import finishes, and only https is accepted. |

The verifier also found problems introduced by the first round of fixes. These were fixed too:

- The global login and lookup limits could lock everyone out.
- The offline queue dropped registrations when the server said "busy".
- A hard block per mobile number could be abused to stop someone registering.
- The ID counter was using up the script's storage quota.

## Depends on how you set things up (please follow the README)

- **Keep Sheet editors to yourself.**
  - The script is attached to the Sheet, and its scheduled jobs run as you, with access to your Google Drive. Anyone who can edit the Sheet can change that code.
  - Give organisers access only through the admin website and its roles (the Admins tab).
  - Ideally, use a separate Google account just for this project.
- **Admin passwords.**
  - These are now stored as salted hashes.
  - A password typed into the Admins tab is hashed within seconds, but it stays in the Sheet's version history.
  - So set a temporary password there, then change it from the dashboard ("Password" button).
  - Keep the Sheet and its Drive folder private.

## Known limit (by design)

"Edit my registration" uses the registration number and mobile, as chosen. Someone who knows a volunteer's mobile can still try registration numbers, now limited to 10 tries per hour per mobile.

A per-volunteer secret code, or an OTP sent by SMS, would close this. Both are possible later.
