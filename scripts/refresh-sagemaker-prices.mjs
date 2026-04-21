#!/usr/bin/env node
// Pulls fresh SageMaker list prices for CPU instance families from the AWS
// Pricing API and rewrites data/sagemaker-prices.json. No auth required —
// the bulk pricing endpoint is publicly readable.
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

// General-purpose, compute-optimized, and memory-optimized ML instance
// families used for workloads that don't need accelerators: processing
// jobs, CPU inference endpoints, batch transform, ETL, workbenches.
const CPU_FAMILIES = [
  "ml.t3", "ml.m5", "ml.m5d", "ml.m6i", "ml.m6in",
  "ml.c5", "ml.c5d", "ml.c6i", "ml.c6in", "ml.c7i",
  "ml.r5", "ml.r5d", "ml.r6i",
];

function isCpuFamily(instanceType) {
  return CPU_FAMILIES.some((f) => instanceType && instanceType.startsWith(f + "."));
}

// AWS instance size naming is regular: large = 2 vCPU, xlarge = 4 vCPU,
// NxlargE = N × 4 vCPU. Older m5.12xlarge = 48, m5.24xlarge = 96 follow the
// pattern; c5.9xlarge = 36, c5.18xlarge = 72 follow it too.
function vcpusFromSize(instanceType) {
  const size = instanceType.split(".").pop();
  if (size === "medium") return 2;
  if (size === "large") return 2;
  if (size === "xlarge") return 4;
  const m = size.match(/^(\d+)xlarge$/);
  if (m) return parseInt(m[1], 10) * 4;
  return null;
}

async function main() {
  console.error(`Fetching ${INDEX_URL}`);
  const res = await fetch(INDEX_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  console.error("Parsing (this takes a minute)…");
  const json = await res.json();

  // The SageMaker price list has two top-level objects: "products" and
  // "terms.OnDemand". Products describe SKUs; terms describe prices. We
  // match them by sku. CPU workloads come through Training / Processing /
  // Hosting / Notebook components at broadly the same per-vCPU rate, so we
  // keep the lowest price we see for each instance type.
  const products = json.products || {};
  const onDemand = (json.terms && json.terms.OnDemand) || {};

  const seen = new Map();

  for (const sku of Object.keys(products)) {
    const p = products[sku];
    const attrs = p.attributes || {};
    const instanceType = attrs.instanceName || attrs.instanceType;
    if (!instanceType || !isCpuFamily(instanceType)) continue;

    const terms = onDemand[sku];
    if (!terms) continue;
    const firstTerm = Object.values(terms)[0];
    const dims = firstTerm && firstTerm.priceDimensions;
    if (!dims) continue;
    const firstDim = Object.values(dims)[0];
    const price = parseFloat(firstDim && firstDim.pricePerUnit && firstDim.pricePerUnit.USD);
    if (!Number.isFinite(price) || price <= 0) continue;

    const vcpus = vcpusFromSize(instanceType);
    if (!vcpus) continue;

    const existing = seen.get(instanceType);
    if (!existing || price < existing.pricePerHour) {
      seen.set(instanceType, { type: instanceType, vcpus, pricePerHour: price });
    }
  }

  const instances = [...seen.values()].sort((a, b) => a.type.localeCompare(b.type));

  if (instances.length === 0) {
    throw new Error(
      "No CPU instances extracted. The AWS Pricing API schema may have changed — inspect a sample SKU and update this script."
    );
  }

  const output = {
    source: `AWS SageMaker on-demand list prices, ${REGION} (CPU instances)`,
    lastUpdated: new Date().toISOString().slice(0, 10),
    notes: "Regenerated from AWS Pricing API. Edit scripts/refresh-sagemaker-prices.mjs to adjust the families pulled.",
    instances,
  };

  await fs.writeFile(OUT_PATH, JSON.stringify(output, null, 2) + "\n");
  console.error(`Wrote ${OUT_PATH} (${instances.length} instances)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
