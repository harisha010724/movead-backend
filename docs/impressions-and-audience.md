# Impressions and audience data — competitor analysis and recommended strategy

Status: proposal, not yet accepted. Nothing here is implemented.
Written: 22 September 2026.

## Why this document exists

The advertiser dashboard already declares an impressions surface and returns
zero for all of it. `dashboards.service.ts` is explicit that this is a refusal
rather than an omission:

> Impressions are not counted anywhere, and this is not an oversight. No
> acceptance criterion defines what one is — how many people see a wrapped
> vehicle over a kilometre is a research question, not a measurement the
> platform makes.

That refusal was correct and this document does not overturn it. It proposes
what an acceptance criterion should say, having looked at what the two
reference competitors actually do.

## What Wrapify does

Three separable layers, and only the first is an impression.

**Modelled impressions**, patented as
[US20170243249A1](https://patents.google.com/patent/US20170243249A1/en). The
GPS trace is resolved to road segments; each segment is multiplied by
third-party traffic volume for that segment; an "environmental filter" then
discards exposures beyond a visibility distance of roughly 250 feet and adjusts
the count by the ratio of the vehicle's actual speed to the road's free-flow
speed. A kilometre crawled in traffic yields more impressions than the same
kilometre at 80 km/h. Impressions are modelled viewable exposure throughout —
never a count of observed people.

**Standardised reporting.** Wrapify co-authored the DMOOH Exposure Methodology
Standardization Guidelines with the OAAA and Reveal Mobile, and reports against
them. Commercially this is the important layer: the number is credible because
the method is published and externally audited, not because it is precise.

**Attribution**, sold separately. Bluetooth beacons plus driver location
aggregate mobile ad IDs seen within ~50 feet into an "exposed audience", which
is compared against a control group drawn from the same market geofence that was
never within 50 feet. This yields online, in-app and foot-traffic lift, plus
retargeting. Their Trulieve case study reports 18,903,000 impressions at a
$1.17 effective CPM, and a 3x visitation lift for the exposed group.

## What Wrap2Earn does

Simpler, and the direct competitor in this market — Indian, cabs, Tier-1
cities, roughly 5,000 vehicles.

Per their [Media4Growth interview](https://www.media4growth.com/metrics/audience-data-measurement/wrap2earn-renders-measurability-transparency-to-vehicle-branding-3116-51099),
impressions come from a third-party real-time traffic congestion feed around
each branded car, combined with time of day and wrap style, to "compute
potentially the number of eyeballs viewing the branding". Their own phrasing
hedges.

Around that they sell:

- live vehicle positions, including on-trip versus parked
- kilometres by day, broken down by geo-area and by daypart
- heat maps and route coverage
- a tamper-proof photo audit — drivers submit wrap photos through the app
  (not the camera roll) at the campaign midpoint and end

Attribution is QR codes, short URLs, promo codes and landing pages. No ad IDs.

Their stated differentiator is that _"none of the vehicle/cab branding agencies
provide real-time analytics"_. Their moat is a dashboard.

Worth noting: their own blog
[argues against the single big number](https://blog.wrap2earn.com/a-deeper-look-at-how-wrap2earn-helps-brands-measure-out-of-home-campaigns-beyond-just-reach-2/),
saying a cab near IT parks reaching fewer but better-matched people beats a busy
market street. They make the argument rhetorically; they do not appear to have
productised it.

## Where MoveAd stands today

### Already in place

The impressions shape is declared and wired to empty charts:

- `impressions` and `costPerThousandImpressions` on the advertiser dashboard
- `impressionsDaily`, `impressionsHourly`, `impressionsByArea`,
  `impressionsByVehicleType`
- per-vehicle `impressions` in `topVehicles`
- `impressions` on the campaign row

The data underneath is unusually good for this problem:

- `gps_points` carries `speed_mps` and `heading_deg` on every fix, at
  two-second cadence, with `accuracy_m`, `quality` and `recorded_at`
- `trip_segments` carries `distance_km`, zone, state, start and end times, and
  the advertiser and driver rates in force at the time of travel
- `campaigns` carries `locations` — advertiser-nominated places with lat/lng —
  and `zone_polygons` per pricing tier
- `shared/geo.ts` has `pointInPolygon`, `haversineKm` and `splitSegmentByZone`

Most importantly, the billing spine is audit-grade. Every rupee traces to a
specific pair of GPS fixes, rates are frozen onto the segment, and
`uq_trip_segment_part` makes a double-counted kilometre a constraint violation
rather than a quiet discrepancy.

### Missing

- no road-segment traffic volume data
- no population or footfall density data
- no wrap format or coverage field — `installations` tracks photos by angle
  only, so Wrap2Earn's "wrap style" factor has nothing to read
- vehicle type is only `CAB` or `AUTO`
- `impressionsByArea` would currently bucket by the _driver's home area_.
  `topVehicles` derives area from
  `COALESCE(d.base_label, d.address_city, d.city)`, not from where the
  kilometres were actually driven. This must change before an area breakdown
  means anything.

## Recommendation

### The one thing to build

**Guarantee zone delivery, prove it per segment, express it in impressions.**

Not an impressions dashboard. A contracted delivery guarantee with GPS-grade
proof, translated into the currency advertisers budget in.

Concretely:

1. At booking, forecast from MoveAd's own fleet history and commit to a floor —
   _"20 cabs, these polygons, 30 days: minimum 4,200 verified km with at least
   60% in prime, modelling to 9–12M impressions."_
2. During the campaign, show pacing against that floor.
3. At the end, reconcile delivered against forecast.
4. On under-delivery, automatically extend the campaign or add vehicles until
   the floor is met.

### Why this beats Wrap2Earn specifically

Competing on dashboards means fighting their strength with a weaker brand and
fewer vehicles. Their impressions come from a licensed third-party feed, and
that has two consequences they cannot engineer away.

They cannot show provenance, because the data is not theirs — their strongest
verification is a driver photographing a wrap twice a month.

And decisively: **you cannot underwrite a guarantee on somebody else's model.**
A vendor renting its measurement layer has no safe way to promise delivery,
because it neither controls nor owns the thing being measured. MoveAd's billing
spine makes proof of delivery genuinely defensible. A guarantee is the
commercial product that spine was always capable of supporting, and it is
currently pointed inward at dispute resolution only.

It also changes the conversation. Wrap2Earn sells transparency — _look where
your cars are_. This sells accountability — _here is what you will get, and
what you get if we miss_. The second is a procurement discussion; the first is
a demo.

### The design rule that makes it safe

**Guarantee what you measure. Report what you model.**

Never contract on an impression count. Impressions are a model output, so
guaranteeing them means guaranteeing your own arithmetic — circular, and
legally soft the moment a coefficient is revised.

Denominate the contract in verified kilometres per zone plus dwell hours per
zone. Both are GPS-provable, and verified km is already the billing unit. Show
impressions as the derived media translation, labelled as modelled, with a band
and the inputs exposed.

This keeps impressions out of the pricing path, which the existing code already
insists on and is right about.

## The impression model

### The fleet is the traffic sensor

Wrapify buys traffic volume. Wrap2Earn licenses congestion data. Neither is
necessary, because the speed ratio Wrapify's patent uses as a correction factor
can be derived entirely from MoveAd's own GPS.

Build a baseline of free-flow speed per area per hour-of-week from historical
fixes — the 85th percentile observed speed in that cell is the reference. A
vehicle's speed against that baseline is not merely a congestion index. By the
fundamental relation between speed and density, it gives the number of vehicles
on that stretch of road outright, and those vehicles are the audience.

This compounds. Every kilometre any driver covers improves the baseline for
every future campaign. It is a first-party asset that a competitor renting a
traffic feed cannot replicate, and it costs nothing but storage.

### Shape of the per-segment calculation

A first draft of this section multiplied a static `audience_density` by a
separate `congestion_multiplier`. That is wrong, and wrong in the direction
that flatters the headline number: the two are one physical quantity counted
twice, so the model squared the congestion effect. Density is not a constant
that congestion modifies — density is what congestion measures.

```
persons_per_km = traffic_density(observed_kmh, baseline_kmh, lanes)
                   x occupants_per_vehicle
               + pedestrian_density(zone)

impressions    = distance_km
               x persons_per_km
               x line_of_sight_share            // could they see the wrap at all
               x wrap_quality(vehicle, coverage)
               x daypart_factor(hour, daylight)
```

### Density from first principles

`traffic_density` is Greenshields' relation between speed and density, the
standard first approximation in traffic engineering:

```
veh_per_km_per_lane = jam_density x (1 - observed_kmh / baseline_kmh)
```

clamped at zero, since a vehicle beating the p85 baseline is on an empty road.
`jam_density` is near enough a physical constant — how many vehicles fit in a
kilometre of lane bumper to bumper, about 150 for mixed Indian traffic where
two-wheelers fill the gaps. Greenshields is crude, and Greenberg or Underwood
fit observed data better at the extremes. At the precision this model claims
the linear form is enough, and its one parameter can be defended from a
photograph.

So the largest term in the audience — people inside other vehicles — needs no
external data at all. It falls out of the fleet's own speed baseline and a
constant.

### A worked segment

A cab on a prime corridor, Tuesday 18:40. Two consecutive fixes 21 m apart,
6.3 s between them: 12.0 km/h observed against a 34.0 km/h baseline for that
cell and that hour.

```
150 x (1 - 12.0/34.0)   =  97 veh/km/lane
x 4 visible lanes       = 388 veh/km
x 1.5 occupants         = 582 persons/km in vehicles
+ 120 pedestrians/km    = 702 persons/km present
x 0.30 line of sight    = 211 with a viewing opportunity
x 0.85 wrap quality     = 179
x 0.75 daypart (dusk)   = 134 effective impressions per km
x 0.021 km              =   2.82 impressions
```

Those coefficients are the `v1.0.0` set in `src/impressions/coefficients.ts`, and
`test/impressions.test.ts` asserts this worked example against the code. If the
two ever disagree, one of them has moved without the other.

The result is fractional and usually will be: the recording gate puts
consecutive fixes about 20 m apart, so most segments deliver well under one
impression. The stored value must be `NUMERIC`, and rounding must happen at
presentation only — round per segment and a day of 20-metre hops sums to zero.

Two checks on the coefficients, both available the moment the model runs.
Scaled to a working day this is roughly 2,000 impressions per vehicle, near
61,000 a month, which sits inside the 30,000–80,000 band Wrapify publishes
from entirely different inputs. And the day's advertiser charge over its
impressions gives a CPM around ₹49, inside the normal range for Indian transit
OOH. A CPM of ₹5 or ₹500 means a coefficient is wrong, and says so without any
ground truth being needed at all.

### Why visibility is two coefficients, not one

`wrap_quality` and `line_of_sight_share` are held apart deliberately. The first
is a property of the vehicle — a full sedan wrap against a door decal. The
second is a property of geometry: traffic ahead of the vehicle, and lanes
facing away from it, cannot see the wrap however good it is. Roughly a third of
the people present have a viewing opportunity at all.

Collapsed into one number they give a coefficient around 0.25 that nobody can
derive, defend or argue with. Held apart, each is separately challengeable,
which is the entire point of a glass box.

### Where the values come from

| Input                   | Source                                     | Cost |
| ----------------------- | ------------------------------------------ | ---- |
| `baseline_kmh`          | Own GPS, p85 per cell per hour-of-week     | free |
| `jam_density`           | Physical constant, ~150 veh/km/lane        | free |
| `lanes`, road class     | OpenStreetMap                              | free |
| `occupants_per_vehicle` | Published transport studies, ~1.5 urban IN | free |
| `line_of_sight_share`   | Geometry, calibrated by manual count       | free |
| `pedestrian_density`    | Ops-set constant per zone polygon          | free |

Only the last has no principled derivation, and no fleet of cars can measure
it. It stays an ops constant, and it should be labelled as an assumption in the
advertiser's "how this was calculated" panel rather than buried among the
measured inputs. It is also the smallest term, so the one number that cannot be
defended is the one that moves the answer least.

Later, WorldPop or Meta Data for Good rasters can replace the pedestrian
constant with a gridded lookup, and Census 2011 ward density is dated but
usable. Google Roads and Traffic are paid, and their terms restrict storing
derived data — which rules them out for a figure that has to sit behind an
invoice.

Validation is cheap: one person on a prime corridor for fifteen minutes,
counting vehicles, tests the Greenshields output directly at a known point.

### Storing the result

Not on `trip_segments`. That table's promise is that a kilometre is priced at
what it was worth when it was driven and is never restated, which is why
`advertiser_rate` is frozen onto each row. Impressions are the opposite kind of
number — modelled, and certain to improve. Putting them there forces a choice
between freezing a figure known to be improvable and restating rows in the one
table that must never restate.

A separate `segment_impressions` instead, keyed `(segment_id, model_version)`,
holding every input beside the output. A new model version inserts rows beside
the old ones rather than over them. A campaign pins the version it was sold on,
so an advertiser's number never moves mid-flight, while the next campaign is
sold on the better model.

### Two metrics competitors structurally cannot report

**Dwell impressions.** Both rivals tie impressions to mileage. A cab idling at
a signal for four minutes is genuinely being seen and produces zero mileage.
Because the app now samples every two seconds regardless of movement, MoveAd has
the data to count stationary exposure as a separate line item. This is also the
strongest justification for the battery cost of timer-based sampling.

**Proximity impressions.** Campaigns already store `locations` from when the
advertiser searched for their own outlets. Computing _"18% of your impressions
landed within 500 m of your own stores"_ needs no new data source and roughly
one query. It converts an abstract number into the one an advertiser cares
about, and it operationalises the argument Wrap2Earn only makes in prose.

## Proof surface

The GPS audit page is the proof asset — it simply points the wrong way. It is
admin-only behind `trip.audit`, deliberately, because it exposes both sides of
the money:

> `trip.audit` rather than `vehicle.read`: this is the first route behind that
> permission, and it is a separate grant because it exposes both sides of the
> money — what the driver earned and what the advertiser was charged — to
> whoever is settling a dispute between them.

The pattern for fixing that already exists. `driverTrip` reuses the same segment
machinery and strips the advertiser side before it reaches a driver. An
advertiser-scoped variant that strips the _driver_ side is the mirror image,
same shape, and turns an internal ops tool into the differentiating sales asset.

Alongside it, report impressions as a band — low, expected, high — with a "how
this was calculated" panel showing the real inputs: kilometres by zone, hours by
daypart, observed and baseline speed, the vehicle density those imply, the
pedestrian assumption, line of sight, and wrap quality.
Every one traces back to the same `trip_segments` rows that back the invoice.
No competitor can show an advertiser the GPS segment behind an impression.

Publish the methodology as a document, as Wrapify did with the OAAA.
Credibility, not magnitude, is what closes enterprise deals.

## What not to build

**Ad-ID attribution.** Wrapify's best product and MoveAd's worst fit. India's
DPDP Act 2023 makes harvesting identifiers from non-consenting bystanders
legally hazardous in a way it is not in the US, and they have beacon hardware
plus years of head start. Use Wrap2Earn's approach for attribution: QR codes,
campaign short URLs, promo codes.

**Licensed congestion data, at least initially.** A recurring cost that makes
MoveAd a Wrap2Earn clone, and worse, prevents the proprietary baseline from ever
accumulating. The fleet improving its own measurement with every kilometre is
the asset; renting the measurement destroys it.

**Reach or unique-audience claims.** De-duplicating people requires identity
data MoveAd will not have. Gross impressions with an explicitly stated frequency
assumption is the honest ceiling, and being visibly honest about that is itself
a differentiator in a market conditioned to inflated OOH numbers.

## Order of work

1. **Speed baseline per area per hour.** First, because everything downstream
   reads from it. It is fully backfillable — `gps_points` are retained and no
   purge job exists — so the constraint is fleet coverage, not elapsed time.
   That changes if a retention policy ever lands: baselines must then be
   computed before points age out.
2. **Per-segment impression value in `segment_impressions`, with its model
   version.** Fills the four existing dashboard charts and gives something to
   show.
3. **Advertiser-scoped audit view.** The proof surface.
4. **Proximity impressions to advertiser locations.** Cheap, high impact.
5. **Booking forecast and guarantee mechanics.** Last, once there is enough
   history to underwrite a floor without guessing.

The guarantee is the product. The impression model is how it gets priced and
described.

## Open questions

- ~~What is the acceptance criterion for an impression?~~ Settled: one
  vehicle-occupant or pedestrian with a viewing opportunity, counted gross.
  Opportunity-to-see, not attention — which is how OOH is traded, and is the
  strongest claim GPS alone can support.
- Does `wrap_coverage` get added to `installations`, and who sets it — the
  installer at submission, or the campaign at creation?
- `lanes` has to come from somewhere per grid cell. An OpenStreetMap import at
  cell resolution, or an ops-set default per zone until that exists?
- What tolerance does a guarantee carry, and who signs off on a make-good?
- Should drivers see an impressions figure at all? It is motivating, but risks
  implying they are paid on impressions rather than verified kilometres.
