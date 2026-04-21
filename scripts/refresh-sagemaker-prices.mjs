#!/usr/bin/env node
// Pulls fresh SageMaker list prices from the AWS Pricing API and rewrites
// data/sagemaker-prices.json. No auth required — the bulk pricing endpoint
// is publicly readable.
//
// Usage:
//   node scripts/refresh-sagemaker-prices.mjs           # us-east-1
//   node scripts/refresh-sagemaker-prices.mjs eu-west-1
//
// Heads up: the SageMaker pricing file is large (~hundreds of MB). This
// script streams and filters as it goes; expect it to take a minute or two
// and use ~1-2 GB of RAM during parse.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.resolve(__dirname, "..", "data", "sagemaker-prices.json");

const REGION = process.argv[2] || "us-east-1";
const INDEX_URL = `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonSageMaker/current/${REGION}/index.json`;

// Curated instance families we care about. The API has hundreds of SKUs
// across notebook/training/processing/endpoint/batch/serverless tiers; we
// only surface the GPU-bearing ones that users pick for ML.
const GPU_FAMILIES = [
  "ml.g5", "ml.g6", "ml.g6e",
  "ml.p4d", "ml.p4de", "ml.p5", "ml.p5e",
  "ml.inf2", "ml.trn1", "ml.trn2",
];

// Hardcoded GPU-per-instance map. The Pricing API describes instance
// hardware in free-form attributes that change shape often, so keeping
// this local is more reliable than parsing it out.
const GPU_META = {
  "ml.g5.xlarge":     { gpus: 1, gpuModel: "A10G" },
  "ml.g5.2xlarge":    { gpus: 1, gpuModel: "A10G" },
  "ml.g5.4xlarge":    { gpus: 1, gpuModel: "A10G" },
  "ml.g5.8xlarge":    { gpus: 1, gpuModel: "A10G" },
  "ml.g5.16xlarge":   { gpus: 1, gpuModel: "A10G" },
  "ml.g5.12xlarge":   { gpus: 4, gpuModel: "A10G" },
  "ml.g5.24xlarge":   { gpus: 4, gpuModel: "A10G" },
  "ml.g5.48xlarge":   { gpus: 8, gpuModel: "A10G" },
  "ml.g6.xlarge":     { gpus: 1, gpuModel: "L4" },
  "ml.g6.2xlarge":    { gpus: 1, gpuModel: "L4" },
  "ml.g6.4xlarge":    { gpus: 1, gpuModel: "L4" },
  "ml.g6.8xlarge":    { gpus: 1, gpuModel: "L4" },
  "ml.g6.16xlarge":   { gpus: 1, gpuModel: "L4" },
  "ml.g6.12xlarge":   { gpus: 4, gpuModel: "L4" },
  "ml.g6.24xlarge":   { gpus: 4, gpuModel: "L4" },
  "ml.g6.48xlarge":   { gpus: 8, gpuModel: "L4" },
  "ml.g6e.xlarge":    { gpus: 1, gpuModel: "L40S" },
  "ml.g6e.12xlarge":  { gpus: 4, gpuModel: "L40S" },
  "ml.g6e.48xlarge":  { gpus: 8, gpuModel: "L40S" },
  "ml.p4d.24xlarge":  { gpus: 8, gpuModel: "A100-40GB" },
  "ml.p4de.24xlarge": { gpus: 8, gpuModel: "A100-80GB" },
  "ml.p5.48xlarge":   { gpus: 8, gpuModel: "H100" },
  "ml.p5e.48xlarge":  { gpus: 8, gpuModel: "H200" },
  "ml.inf2.xlarge":   { gpus: 1, gpuModel: "Inferentia2" },
  "ml.inf2.8xlarge":  { gpus: 1, gpuModel: "Inferentia2" },
  "ml.inf2.24xlarge": { gpus: 6, gpuModel: "Inferentia2" },
  "ml.inf2.48xlarge": { gpus: 12, gpuModel: "Inferentia2" },
  "ml.trn1.32xlarge": { gpus: 16, gpuModel: "Trainium" },
  "ml.trn2.48xlarge": { gpus: 16, gpuModel: "Trainium2" },
};

function isGpuFamily(instanceType) {
  return GPU_FAMILIES.some((f) => instanceType && instanceType.startsWith(f + "."));
}

async function main() {
  console.error(`Fetching ${INDEX_URL}`);
  const res = await fetch(INDEX_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  console.error("Parsing (this takes a minute)…");
  const json = await res.json();

  // The SageMaker price list has two top-level objects: "products" and
  // "terms.OnDemand". Products describe SKUs; terms describe prices.
  // We match them by sku and bucket by component (training/real-time
  // inference) based on the "operation" / "component" attributes.
  const products = json.products || {};
  const onDemand = (json.terms && json.terms.OnDemand) || {};

  const byBucket = { training: new Map(), inference: new Map() };

  for (const sku of Object.keys(products)) {
    const p = products[sku];
    const attrs = p.attributes || {};
    const instanceType = attrs.instanceName || attrs.instanceType;
    if (!instanceType || !isGpuFamily(instanceType)) continue;

    // Component values vary over time. Treat "Training" / "Hosting" / "Real-Time Inference"
    // as our two buckets; skip Notebook/Processing/Batch/Serverless.
    const component = (attrs.component || attrs.operation || "").toLowerCase();
    let bucket = null;
    if (component.includes("training")) bucket = "training";
    else if (component.includes("hosting") || component.includes("real")) bucket = "inference";
    if (!bucket) continue;

    // Pull the price.
    const terms = onDemand[sku];
    if (!terms) continue;
    const firstTerm = Object.values(terms)[0];
    const dims = firstTerm && firstTerm.priceDimensions;
    if (!dims) continue;
    const firstDim = Object.values(dims)[0];
    const price = parseFloat(firstDim && firstDim.pricePerUnit && firstDim.pricePerUnit.USD);
    if (!Number.isFinite(price) || price <= 0) continue;

    // Prefer the lowest price we see per (bucket, instance) — the API can
    // list multiple operation flavors for the same type.
    const existing = byBucket[bucket].get(instanceType);
    if (!existing || price < existing.pricePerHour) {
      const meta = GPU_META[instanceType] || { gpus: 1, gpuModel: "unknown" };
      byBucket[bucket].set(instanceType, {
        type: instanceType,
        gpus: meta.gpus,
        gpuModel: meta.gpuModel,
        pricePerHour: price,
      });
    }
  }

  const sortFn = (a, b) => a.type.localeCompare(b.type);
  const output = {
    source: `AWS SageMaker on-demand list prices, ${REGION}`,
    lastUpdated: new Date().toISOString().slice(0, 10),
    notes: `Regenerated from AWS Pricing API. Edit scripts/refresh-sagemaker-prices.mjs to adjust families or GPU metadata.`,
    instances: {
      training: [...byBucket.training.values()].sort(sortFn),
      inference: [...byBucket.inference.values()].sort(sortFn),
    },
  };

  if (output.instances.training.length === 0 && output.instances.inference.length === 0) {
    throw new Error(
      "No GPU instances extracted. The AWS Pricing API schema may have changed — inspect the 'component'/'operation' attributes in a sample SKU and update this script."
    );
  }

  await fs.writeFile(OUT_PATH, JSON.stringify(output, null, 2) + "\n");
  console.error(
    `Wrote ${OUT_PATH} (${output.instances.training.length} training, ${output.instances.inference.length} inference)`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
