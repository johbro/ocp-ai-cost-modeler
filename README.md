# OCP AI Cost Modeler

A static web app that compares monthly and multi-year ML workload costs between
**AWS SageMaker** and **Red Hat OpenShift AI on baremetal**. Tweak the inputs,
read the summary, see the breakeven point.

Live demo: enable GitHub Pages on this repo (see [Deploy](#deploy)).

## What it models

Six cost categories are compared per side:

| Category | SageMaker | OpenShift AI baremetal |
| --- | --- | --- |
| **GPU compute** | `GPUs × hours × avg $/GPU-hr` (training and inference averaged separately from list prices) | Fixed TCO: capex amortization + RH subscriptions + power × PUE + ops overhead |
| **CPU compute** | `vCPUs × hours × avg $/vCPU-hr` for non-training use cases (processing, batch, CPU inference, ETL) | Absorbed by the main cluster by default, or dedicated `$/vCPU-hr` rate |
| **Workspaces** | Studio / notebook instance-hours per user | Workbenches; shared with the GPU cluster by default, or `$/user/month` for dedicated nodes |
| **Storage** | S3 Standard `$/GB-month` | Amortized on-prem storage `$/TB-month` (ODF / Ceph / SAN) |
| **Egress** | Internet out `$/GB` past free tier | Colo / transit `$/GB` |

SageMaker prices come from a **dated snapshot** in
[`data/sagemaker-prices.json`](data/sagemaker-prices.json), refreshable via
script. GPU instance prices are averaged across many families (no single SKU
picker, by design). Non-GPU pricing is averaged across general-purpose,
compute-optimized, and memory-optimized ML instance families.

Because most OpenShift costs are flat (cluster runs 24/7) and SageMaker
compute is linear in hours, the two total-cost lines cross at a breakeven
point — the "Cost vs. monthly GPU-hours" chart shows exactly where, with
fixed auxiliary costs (storage, egress, workspaces) already factored in.

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

The **"absorb CPU workloads"** and **"workbenches share the main cluster"**
checkboxes collapse those categories to $0 marginal on the OpenShift side
(the assumption being that an 8-GPU node with 96 CPU cores already has
capacity to spare for non-GPU work). Uncheck them to model dedicated CPU
worker pools or dedicated notebook nodes.

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
- Inference on SageMaker here means **GPU real-time endpoints**. Serverless
  Inference and Asynchronous Inference have different pricing shapes and
  are not modeled as their own category. Batch Transform and Processing
  jobs roll into the **CPU compute** category via the `$/vCPU-hr` average.
- Storage modeling is **S3 Standard only** on the AWS side. Intelligent
  Tiering, Glacier, and EFS are not broken out.
- Egress is a flat blended rate. Real AWS egress tiers (100 GB free, then
  steps down at 10 TB / 50 TB / 150 TB) are not modeled.
- GPU families not in the refresh script's `GPU_META` map appear as
  `gpuModel: "unknown"`; they still contribute to the average using the
  `gpus` count the API reports (or `1` if unspecified), so verify those
  before publishing.
