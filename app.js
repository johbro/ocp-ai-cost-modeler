const HOURS_PER_YEAR = 8760;
const HOURS_PER_MONTH = 730;

const state = {
  prices: null,
  avgTrain: 0,
  avgInf: 0,
  charts: { monthly: null, tco: null, sweep: null },
};

async function loadPrices() {
  const res = await fetch("data/sagemaker-prices.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(`Failed to load prices: ${res.status}`);
  return res.json();
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function computeAverages(prices) {
  const perGpuTrain = prices.instances.training.map((i) => i.pricePerHour / i.gpus);
  const perGpuInf = prices.instances.inference.map((i) => i.pricePerHour / i.gpus);
  return { avgTrain: average(perGpuTrain), avgInf: average(perGpuInf) };
}

function formatMoney(n) {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function formatMoneyFull(n) {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function readInputs() {
  const num = (id) => parseFloat(document.getElementById(id).value) || 0;
  return {
    trainGpus: num("trainGpus"),
    trainHours: num("trainHours"),
    infGpus: num("infGpus"),
    infHours: num("infHours"),
    sharedPool: document.getElementById("sharedPool").checked,
    serverCost: num("serverCost"),
    gpusPerServer: Math.max(1, num("gpusPerServer")),
    amortYears: Math.max(1, num("amortYears")),
    ocpSubPerServer: num("ocpSubPerServer"),
    ocpAiPerGpu: num("ocpAiPerGpu"),
    kwPerServer: num("kwPerServer"),
    kwhCost: num("kwhCost"),
    pue: Math.max(1, num("pue")),
    opsPct: num("opsPct"),
    utilPct: Math.max(1, Math.min(100, num("utilPct"))),
  };
}

function computeSageMaker(i, rates) {
  const train = i.trainGpus * i.trainHours * rates.avgTrain;
  const inference = i.infGpus * i.infHours * rates.avgInf;
  return { train, inference, total: train + inference };
}

function computeOpenShift(i) {
  const peakGpus = i.sharedPool
    ? Math.max(i.trainGpus, i.infGpus)
    : i.trainGpus + i.infGpus;

  if (peakGpus === 0) {
    return {
      peakGpus: 0, servers: 0,
      annual: 0, monthly: 0, tco: 0,
      effectivePerGpuHour: 0,
      breakdown: { hardware: 0, subscriptions: 0, power: 0, ops: 0 },
    };
  }

  const servers = Math.ceil(peakGpus / i.gpusPerServer);
  const capex = servers * i.serverCost;
  const hardwareAnnual = capex / i.amortYears;
  const subsAnnual = servers * i.ocpSubPerServer + peakGpus * i.ocpAiPerGpu;
  const powerAnnual = servers * i.kwPerServer * HOURS_PER_YEAR * i.kwhCost * i.pue;
  const opsAnnual = capex * (i.opsPct / 100);

  const annual = hardwareAnnual + subsAnnual + powerAnnual + opsAnnual;
  const monthly = annual / 12;
  const tco = annual * i.amortYears;

  const effectiveGpuHours = peakGpus * HOURS_PER_YEAR * (i.utilPct / 100);
  const effectivePerGpuHour = effectiveGpuHours > 0 ? annual / effectiveGpuHours : 0;

  return {
    peakGpus, servers,
    annual, monthly, tco,
    effectivePerGpuHour,
    breakdown: {
      hardware: hardwareAnnual / 12,
      subscriptions: subsAnnual / 12,
      power: powerAnnual / 12,
      ops: opsAnnual / 12,
    },
  };
}

function destroyChart(key) {
  if (state.charts[key]) {
    state.charts[key].destroy();
    state.charts[key] = null;
  }
}

function renderMonthlyChart(sm, ocp) {
  destroyChart("monthly");
  const ctx = document.getElementById("monthlyChart");
  state.charts.monthly = new Chart(ctx, {
    type: "bar",
    data: {
      labels: ["Training", "Inference", "Total"],
      datasets: [
        {
          label: "SageMaker",
          backgroundColor: "#ff9900",
          data: [sm.train, sm.inference, sm.total],
        },
        {
          label: "OpenShift AI (fixed)",
          backgroundColor: "#d43b3b",
          data: [ocp.monthly, ocp.monthly, ocp.monthly],
        },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        tooltip: {
          callbacks: { label: (c) => `${c.dataset.label}: ${formatMoneyFull(c.raw)}` },
        },
      },
      scales: { y: { ticks: { callback: (v) => formatMoney(v) } } },
    },
  });
}

function renderTcoChart(sm, ocp, years) {
  destroyChart("tco");
  const ctx = document.getElementById("tcoChart");
  const smTco = sm.total * 12 * years;
  state.charts.tco = new Chart(ctx, {
    type: "bar",
    data: {
      labels: [`${years}-year TCO`],
      datasets: [
        { label: "SageMaker", backgroundColor: "#ff9900", data: [smTco] },
        { label: "OpenShift AI", backgroundColor: "#d43b3b", data: [ocp.tco] },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        tooltip: {
          callbacks: { label: (c) => `${c.dataset.label}: ${formatMoneyFull(c.raw)}` },
        },
      },
      scales: { y: { ticks: { callback: (v) => formatMoney(v) } } },
    },
  });
}

function renderSweepChart(inputs, rates, ocpMonthly) {
  destroyChart("sweep");
  const ctx = document.getElementById("sweepChart");
  const totalGpus = inputs.trainGpus + inputs.infGpus;
  const blendedRate = totalGpus > 0
    ? (inputs.trainGpus * rates.avgTrain + inputs.infGpus * rates.avgInf) / totalGpus
    : 0;

  const maxHours = Math.max(HOURS_PER_MONTH, (inputs.trainHours + inputs.infHours) * 1.5, 100);
  const steps = 40;
  const labels = [];
  const sageLine = [];
  const ocpLine = [];
  for (let s = 0; s <= steps; s++) {
    const h = (maxHours * s) / steps;
    labels.push(Math.round(h));
    sageLine.push(h * totalGpus * blendedRate);
    ocpLine.push(ocpMonthly);
  }

  state.charts.sweep = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "SageMaker", borderColor: "#ff9900", backgroundColor: "#ff990033", data: sageLine, tension: 0.1, pointRadius: 0 },
        { label: "OpenShift AI (fixed)", borderColor: "#d43b3b", backgroundColor: "#d43b3b33", data: ocpLine, tension: 0, pointRadius: 0, borderDash: [6, 4] },
      ],
    },
    options: {
      responsive: true,
      interaction: { mode: "index", intersect: false },
      plugins: {
        tooltip: {
          callbacks: {
            title: (items) => `${items[0].label} GPU-hours / month`,
            label: (c) => `${c.dataset.label}: ${formatMoneyFull(c.raw)}`,
          },
        },
      },
      scales: {
        x: { title: { display: true, text: "GPU-hours per month (across all GPUs)" } },
        y: { ticks: { callback: (v) => formatMoney(v) } },
      },
    },
  });

  const note = document.getElementById("breakevenNote");
  if (totalGpus === 0 || blendedRate === 0) {
    note.textContent = "Enter GPU counts to see breakeven.";
    return;
  }
  const breakevenGpuHours = ocpMonthly / blendedRate;
  const breakevenHoursPerGpu = breakevenGpuHours / totalGpus;
  note.innerHTML =
    `Breakeven: <strong>${Math.round(breakevenGpuHours).toLocaleString()} GPU-hours / month</strong> ` +
    `(≈ <strong>${breakevenHoursPerGpu.toFixed(0)} hrs/month per GPU</strong>). ` +
    `Below that, SageMaker wins; above, OpenShift AI wins.`;
}

function renderSummary(sm, ocp, inputs, rates) {
  const smMonthly = sm.total;
  const ocpMonthly = ocp.monthly;
  const smTco = sm.total * 12 * inputs.amortYears;
  const ocpTco = ocp.tco;

  let verdictClass = "tie";
  let verdictText = "Costs are within a few percent — the choice likely turns on non-cost factors.";
  const diffPct = smMonthly > 0 && ocpMonthly > 0
    ? Math.abs(smMonthly - ocpMonthly) / Math.max(smMonthly, ocpMonthly)
    : 1;

  if (diffPct > 0.05) {
    if (smMonthly < ocpMonthly) {
      verdictClass = "sagemaker";
      verdictText = `At this workload, SageMaker is ~${Math.round(((ocpMonthly - smMonthly) / ocpMonthly) * 100)}% cheaper per month. Baremetal only pays off at higher sustained utilization.`;
    } else {
      verdictClass = "openshift";
      verdictText = `At this workload, OpenShift AI baremetal is ~${Math.round(((smMonthly - ocpMonthly) / smMonthly) * 100)}% cheaper per month. Sustained utilization is amortizing the cluster well.`;
    }
  }

  const html = `
    <div class="summary-grid">
      <div class="summary-card">
        <div class="label">SageMaker / month</div>
        <div class="value">${formatMoneyFull(smMonthly)}</div>
      </div>
      <div class="summary-card">
        <div class="label">OpenShift AI / month</div>
        <div class="value">${formatMoneyFull(ocpMonthly)}</div>
      </div>
      <div class="summary-card">
        <div class="label">SageMaker ${inputs.amortYears}-yr TCO</div>
        <div class="value">${formatMoneyFull(smTco)}</div>
      </div>
      <div class="summary-card">
        <div class="label">OpenShift AI ${inputs.amortYears}-yr TCO</div>
        <div class="value">${formatMoneyFull(ocpTco)}</div>
      </div>
      <div class="summary-card">
        <div class="label">OCP cluster size</div>
        <div class="value">${ocp.servers} srv / ${ocp.peakGpus} GPU</div>
      </div>
      <div class="summary-card">
        <div class="label">OCP effective $/GPU-hr @ ${inputs.utilPct}%</div>
        <div class="value">$${ocp.effectivePerGpuHour.toFixed(2)}</div>
      </div>
    </div>
    <div class="verdict ${verdictClass}">${verdictText}</div>
    <details style="margin-top: 0.75rem;">
      <summary>OpenShift AI monthly cost breakdown</summary>
      <ul>
        <li>Hardware (amortized): ${formatMoneyFull(ocp.breakdown.hardware)}</li>
        <li>Subscriptions (OCP + OAI): ${formatMoneyFull(ocp.breakdown.subscriptions)}</li>
        <li>Power + cooling (PUE applied): ${formatMoneyFull(ocp.breakdown.power)}</li>
        <li>Ops overhead: ${formatMoneyFull(ocp.breakdown.ops)}</li>
      </ul>
    </details>
  `;
  document.getElementById("summary").innerHTML = html;
}

function renderInstanceList(prices) {
  const el = document.getElementById("instanceList");
  const row = (i) =>
    `<div class="row"><span>${i.type} · ${i.gpus}× ${i.gpuModel}</span><span>$${i.pricePerHour.toFixed(3)}/hr · $${(i.pricePerHour / i.gpus).toFixed(3)}/GPU-hr</span></div>`;
  el.innerHTML =
    `<div style="margin-top:0.5rem;color:var(--text)"><strong>Training</strong></div>` +
    prices.instances.training.map(row).join("") +
    `<div style="margin-top:0.5rem;color:var(--text)"><strong>Real-time inference</strong></div>` +
    prices.instances.inference.map(row).join("");
}

function update() {
  const inputs = readInputs();
  const rates = { avgTrain: state.avgTrain, avgInf: state.avgInf };
  const sm = computeSageMaker(inputs, rates);
  const ocp = computeOpenShift(inputs);

  document.getElementById("avgTrainRate").textContent = `$${state.avgTrain.toFixed(3)}/GPU-hr`;
  document.getElementById("avgInfRate").textContent = `$${state.avgInf.toFixed(3)}/GPU-hr`;

  renderMonthlyChart(sm, ocp);
  renderTcoChart(sm, ocp, inputs.amortYears);
  renderSweepChart(inputs, rates, ocp.monthly);
  renderSummary(sm, ocp, inputs, rates);
}

function attachListeners() {
  document.querySelectorAll("input").forEach((el) => {
    el.addEventListener("input", update);
    el.addEventListener("change", update);
  });
}

async function init() {
  try {
    state.prices = await loadPrices();
    const avgs = computeAverages(state.prices);
    state.avgTrain = avgs.avgTrain;
    state.avgInf = avgs.avgInf;

    document.getElementById("dataStamp").textContent =
      `SageMaker pricing snapshot: ${state.prices.lastUpdated} · ${state.prices.source}`;

    renderInstanceList(state.prices);
    attachListeners();
    update();
  } catch (err) {
    document.getElementById("dataStamp").textContent = `Error loading pricing: ${err.message}`;
    console.error(err);
  }
}

init();
