# Pipeline SQL

Raw, parameterised SQL for the parts of the system Sequelize does not own: GPS
ingestion, zone classification, segment allocation and billing aggregation
(architecture Part 1.2).

These are `.sql` files rather than template literals for three reasons. They can
be run and explained directly against a database while tuning. They diff
readably when a query plan changes. And they cannot accidentally interpolate a
value, because parameters are `$1`, `$2` and nothing else.

**Never concatenate a value into one of these files.** Every input is a bind
parameter, including identifiers that look harmless like a campaign id.
