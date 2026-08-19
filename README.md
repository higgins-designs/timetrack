# Higgins-Designs — Time & Site Visits

Internal tool for Higgins-Designs, PC. Staff sign in to track time against
projects and log site visits.

Static front-end only: three files, no build step. All data lives in a Postgres
database behind Row Level Security, and nothing is readable without a login —
the anonymous role has no access to any table.

Not open for public sign-up. New accounts are created inactive and must be
activated by an administrator.
