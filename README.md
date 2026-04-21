# OCP AI Cost Modeler

A static web app that compares monthly and multi-year ML workload costs between
**AWS SageMaker** and **Red Hat OpenShift AI on baremetal**. Tweak the inputs,
read the summary, see the breakeven point.

Live demo: enable GitHub Pages on this repo (see [Deploy](#deploy)).

## What it models

| Side | Cost shape | Data source |
| --- | --- | --- |
| **SageMaker** | Linear in GPU-hours: `GPUs × hours × avg $/GPU-hr` | Dated snapshot of AWS list prices in [`data/sagemaker-prices.json`](data/sagemaker-prices.json), refreshable via script |
| **OpenShift AI baremetal** | **Fixed** — cluster runs 24/7 regardless of usage | Total-cost-of-ownership model built from form inputs (capex amortization + RH subscriptions + power × PUE + ops overhead) |

The SageMaker side averages **$/GPU-hour across many instance families** rather
than asking you to pick one SKU. Training and real-time inference rates are
averaged separately (inference has a hosting markup).

Because OpenShift cost is flat and SageMaker cost is linear, the two lines
cross at a breakeven point — the "Cost vs. monthly GPU-hours" chart shows
exactly where.

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
to GPU/accelerator families, and rewrites `data/sagemaker-prices.json` with a
fresh `lastUpdated` date. Expect it to take a minute or two and use ~1–2 GB of
RAM during parse.

Instance families that ship with a known GPU-per-instance mapping are tagged
with `gpuModel`. New families the script has not seen before land as
`"gpuModel": "unknown"` — they still count toward the average; edit `GPU_META`
in the script to name them.

## Tune the OpenShift TCO model

Every assumption is a form input with a default. Defaults reflect an average
8-GPU accelerator server; adjust to your environment:

- **Server cost** — per-node capex (default $250k)
- **GPUs per server** — 8 for DGX-style nodes, 4 or fewer for others
- **Amortization period** — straight-line years (default 3)
- **OpenShift Platform Plus** — $/server/year subscription (default $15k)
- **OpenShift AI** — $/GPU/year add-on (default $1.5k)
- **Power** — kW draw per server, $/kWh, and datacenter PUE
- **Ops overhead** — percent of capex per year (default 15%)
- **GPU utilization** — only affects the displayed effective $/GPU-hour

The **"Share a single GPU pool"** checkbox controls whether training and
inference contend for the same cluster (sized to peak) or get dedicated
capacity (sized to sum).

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
data/sagemaker-prices.json          Dated SageMaker price snapshot
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
- Inference on SageMaker here means **real-time endpoints**. Serverless
  Inference, Batch Transform, and Asynchronous Inference have different
  pricing shapes and are not modeled.
- GPU families not in the refresh script's `GPU_META` map appear as
  `gpuModel: "unknown"`; they still contribute to the average using the
  `gpus` count the API reports (or `1` if unspecified), so verify those
  before publishing.
