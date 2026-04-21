# OCP AI Cost Modeler

A static web app that compares monthly and multi-year ML workload costs
between **AWS SageMaker** and **Red Hat OpenShift AI**. Tweak the inputs,
read the summary, see the breakeven point.

Live demo: enable GitHub Pages on this repo (see [Deploy](#deploy)).

## What it models

Four cost categories are compared per side:

| Category | SageMaker | OpenShift AI |
| --- | --- | --- |
| **Compute** | `vCPUs × hours × avg $/vCPU-hr` — averaged across general-purpose, compute-optimized, and memory-optimized ML instance families (m5 / c5 / r5 / t3 / etc.) | Allocated share of a fixed on-prem cluster TCO (hardware amortization + RH subscriptions + power × PUE + ops overhead) |
| **Workspaces** | Studio / notebook instance-hours per user | Allocated share of the same cluster (by vCPU demand) |
| **Storage** | S3 Standard `$/GB-month` | Amortized on-prem storage `$/TB-month` (ODF / Ceph / SAN) |
| **Egress** | Internet out `$/GB` past free tier | Colo / transit `$/GB` |

SageMaker prices come from a **dated snapshot** in
[`data/sagemaker-prices.json`](data/sagemaker-prices.json), refreshable via
script. Instance prices are averaged across many families rather than
asking you to pick one SKU.

Because OpenShift's cluster cost is flat (it runs 24/7) and SageMaker
compute is linear in hours, the two total-cost lines cross at a breakeven
point — the "Cost vs. monthly workload hours" chart shows exactly where,
with fixed auxiliary costs (storage, egress, workspaces) already factored
in.

## Run it locally

No build step. Any static server works:

```bash
python3 -m http.server 8123
# then open http://localhost:8123
```

## Refresh SageMaker prices

The bundled prices are a dated snapshot. To regenerate from the public AWS
Pricing API:

```bash
node scripts/refresh-sagemaker-prices.mjs             # us-east-1 (default)
node scripts/refresh-sagemaker-prices.mjs eu-west-1   # other region
```

The script pulls the full SageMaker price list (several hundred MB), filters
to CPU instance families, and rewrites `data/sagemaker-prices.json` with a
fresh `lastUpdated` date. Expect it to take a minute or two and use ~1–2 GB
of RAM during parse.

vCPU counts are inferred from the standard AWS size suffix (`large`
= 2 vCPU, `xlarge` = 4 vCPU, `Nxlarge` = N × 4 vCPU, with handled
exceptions).

## Tune the OpenShift TCO model

Every assumption is a form input with a default. Defaults reflect a typical
dual-socket CPU node; adjust to your environment:

- **Server cost** — per-node capex (default $20,000)
- **vCPUs per server** — 96 for dual-socket modern (default)
- **Manually size cluster** — off by default (auto-sizes to workload +
  workbench vCPU demand); toggle on and set **Number of servers** to pin a
  specific count and model what-if scenarios
- **Amortization period** — straight-line years (default 3)
- **OpenShift Platform Plus** — $/server/year subscription (default $15k)
- **Power** — kW draw per server, $/kWh, and datacenter PUE
- **Ops overhead** — percent of capex per year (default 15%)
- **vCPU utilization** — only affects the displayed effective $/vCPU-hour

The cluster's monthly total is allocated to the **Compute** and
**Workspaces** chart categories in proportion to their vCPU demand —
keeping the bar chart apples-to-apples against SageMaker. If a manually
sized cluster is too small to actually fit the demand, a warning appears.

## Deploy

This repo is a static site ready for GitHub Pages:

1. Commit and push to `main`.
2. In the repo's **Settings → Pages**, set the source to **`main`** branch,
   folder **`/ (root)`**.
3. Wait for the Pages deployment — your site is at
   `https://<user>.github.io/<repo>/`.

`.nojekyll` is present so paths like `data/sagemaker-prices.json` are served
as-is (no Jekyll processing).

## File layout

```
index.html                          Form + chart layout
styles.css                          Styling
app.js                              Compute + Chart.js rendering
data/sagemaker-prices.json          Dated SageMaker price snapshot (CPU)
scripts/refresh-sagemaker-prices.mjs Regenerates the JSON from AWS Pricing API
.nojekyll                           Tell GitHub Pages to skip Jekyll
```

## Caveats

- Both sides are **list-price oriented**. Real AWS deals (EDP / Savings
  Plans / Spot / Reserved) and real Red Hat subscription quotes both differ
  from list. The inputs are editable — plug in your actual rates.
- The OpenShift TCO model intentionally excludes one-off costs (initial
  networking, rack installation, staff hiring) and treats ops as a flat
  percentage. That is an approximation.
- SageMaker compute here means the average across CPU instance families,
  applied to whatever workload mix you declare (processing, batch
  transform, CPU inference, notebook-adjacent compute). Serverless
  Inference and Asynchronous Inference have different pricing shapes and
  are not modeled separately.
- Storage modeling is **S3 Standard only** on the AWS side. Intelligent
  Tiering, Glacier, and EFS are not broken out.
- Egress is a flat blended rate. Real AWS egress tiers (100 GB free, then
  steps down at 10 TB / 50 TB / 150 TB) are not modeled.
