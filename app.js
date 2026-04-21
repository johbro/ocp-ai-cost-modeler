const HOURS_PER_YEAR = 8760;
const HOURS_PER_MONTH = 730;
const GB_PER_TB = 1000;

const state = {
  prices: null,
  avgCpu: 0,
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
  const list = prices.instances || [];
  const perVcpu = list.filter((i) => i.vcpus && i.vcpus > 0).map((i) => i.pricePerHour / i.vcpus);
  return { avgCpu: average(perVcpu) };
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
  const bool = (id) => document.getElementById(id).checked;
  return {
    cpuCount: num("cpuCount"),
    cpuHours: num("cpuHours"),
    userCount: num("userCount"),
    userHours: num("userHours"),
    smNotebookRate: num("smNotebookRate"),
    nbVcpusPerUser: Math.max(1, num("nbVcpusPerUser")),
    storageTb: num("storageTb"),
    egressTb: num("egressTb"),
    smStorageRate: num("smStorageRate"),
    smEgressRate: num("smEgressRate"),
    ocpStorageRate: num("ocpStorageRate"),
    ocpEgressRate: num("ocpEgressRate"),
    serverCost: num("serverCost"),
    vcpusPerServer: Math.max(1, num("vcpusPerServer")),
    manualSizing: bool("manualSizing"),
    clusterServers: Math.max(1, num("clusterServers")),
    amortYears: Math.max(1, num("amortYears")),
    ocpSubPerServer: num("ocpSubPerServer"),
    kwPerServer: num("kwPerServer"),
    kwhCost: num("kwhCost"),
    pue: Math.max(1, num("pue")),
    opsPct: num("opsPct"),
    utilPct: Math.max(1, Math.min(100, num("utilPct"))),
  };
}

function computeSageMaker(i, rates) {
  const compute = i.cpuCount * i.cpuHours * rates.avgCpu;
  const notebooks = i.userCount * i.userHours * i.smNotebookRate;
  const storage = i.storageTb * GB_PER_TB * i.smStorageRate;
  const egress = i.egressTb * GB_PER_TB * i.smEgressRate;
  const total = compute + notebooks + storage + egress;
  return { compute, notebooks, storage, egress, total };
}

function computeOpenShift(i) {
  const workloadVcpus = i.cpuCount;
  const workbenchVcpus = i.userCount * i.nbVcpusPerUser;
  const totalDemand = workloadVcpus + workbenchVcpus;

  const autoServers = Math.max(1, Math.ceil(totalDemand / i.vcpusPerServer));
  const servers = i.manualSizing ? i.clusterServers : autoServers;
  const clusterVcpus = servers * i.vcpusPerServer;
  const undersized = i.manualSizing && totalDemand > clusterVcpus;

  const capex = servers * i.serverCost;
  const hardwareAnnual = capex / i.amortYears;
  const subsAnnual = servers * i.ocpSubPerServer;
  const powerAnnual = servers * i.kwPerServer * HOURS_PER_YEAR * i.kwhCost * i.pue;
  const opsAnnual = capex * (i.opsPct / 100);
  const clusterAnnual = hardwareAnnual + subsAnnual + powerAnnual + opsAnnual;
  const clusterMonthly = clusterAnnual / 12;

  // Allocate the flat cluster cost across compute and workspaces by vCPU demand.
  // If there's no declared demand but a cluster is defined, attribute all to compute.
  let computeShare, workbenchShare;
  if (totalDemand > 0) {
    computeShare = workloadVcpus / totalDemand;
    workbenchShare = workbenchVcpus / totalDemand;
  } else {
    computeShare = 1;
    workbenchShare = 0;
  }
  const compute = clusterMonthly * computeShare;
  const notebooks = clusterMonthly * workbenchShare;

  const storage = i.storageTb * i.ocpStorageRate;
  const egress = i.egressTb * GB_PER_TB * i.ocpEgressRate;

  const monthly = clusterMonthly + storage + egress;
  const annual = monthly * 12;
  const tco = annual * i.amortYears;

  const effectiveVcpuHours = clusterVcpus * HOURS_PER_YEAR * (i.utilPct / 100);
  const effectivePerVcpuHour = effectiveVcpuHours > 0 ? clusterAnnual / effectiveVcpuHours : 0;

  return {
    servers, clusterVcpus, totalDemand, undersized,
    clusterMonthly,
    compute, notebooks, storage, egress,
    monthly, annual, tco,
    effectivePerVcpuHour,
    breakdown: {
      hardware: hardwareAnnual / 12,
      subscriptions: subsAnnual / 12,
      power: powerAnnual / 12,
      ops: opsAnnual / 12,
      storage,
      egress,
    },
  };
}

function destroyChart(key) {
  if (state.charts[key]) {
    state.charts[key].destroy();
    state.charts[key] = null;
  }
}

const CATEGORIES = ["Compute", "Workspaces", "Storage", "Egress", "Total"];

function smCategories(sm) {
  return [sm.compute, sm.notebooks, sm.storage, sm.egress, sm.total];
}

function ocpCategories(ocp) {
  return [ocp.compute, ocp.notebooks, ocp.storage, ocp.egress, ocp.monthly];
}

function renderMonthlyChart(sm, ocp) {
  destroyChart("monthly");
  const ctx = document.getElementById("monthlyChart");
  state.charts.monthly = new Chart(ctx, {
    type: "bar",
    data: {
      labels: CATEGORIES,
      datasets: [
        { label: "SageMaker", backgroundColor: "#ff9900", data: smCategories(sm) },
        { label: "OpenShift AI", backgroundColor: "#d43b3b", data: ocpCategories(ocp) },
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
  const months = 12 * years;
  const smData = smCategories(sm).map((v) => v * months);
  const ocpData = ocpCategories(ocp).map((v) => v * months);
  state.charts.tco = new Chart(ctx, {
    type: "bar",
    data: {
      labels: CATEGORIES,
      datasets: [
        { label: "SageMaker", backgroundColor: "#ff9900", data: smData },
        { label: "OpenShift AI", backgroundColor: "#d43b3b", data: ocpData },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        title: { display: true, text: `${years}-year totals` },
        tooltip: {
          callbacks: { label: (c) => `${c.dataset.label}: ${formatMoneyFull(c.raw)}` },
        },
      },
      scales: { y: { ticks: { callback: (v) => formatMoney(v) } } },
    },
  });
}

function renderSweepChart(inputs, rates, sm, ocp) {
  destroyChart("sweep");
  const ctx = document.getElementById("sweepChart");
  const vcpus = inputs.cpuCount;

  // Fixed costs that don't scale with workload hours.
  const smFixed = sm.notebooks + sm.storage + sm.egress;
  const ocpTotal = ocp.monthly;

  const maxHours = Math.max(HOURS_PER_MONTH, inputs.cpuHours * 1.5, 100);
  const steps = 40;
  const labels = [];
  const sageLine = [];
  const ocpLine = [];
  for (let s = 0; s <= steps; s++) {
    const h = (maxHours * s) / steps;
    labels.push(Math.round(h));
    sageLine.push(smFixed + h * vcpus * rates.avgCpu);
    ocpLine.push(ocpTotal);
  }

  state.charts.sweep = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "SageMaker (all costs)", borderColor: "#ff9900", backgroundColor: "#ff990033", data: sageLine, tension: 0.1, pointRadius: 0 },
        { label: "OpenShift AI (all costs, fixed)", borderColor: "#d43b3b", backgroundColor: "#d43b3b33", data: ocpLine, tension: 0, pointRadius: 0, borderDash: [6, 4] },
      ],
    },
    options: {
      responsive: true,
      interaction: { mode: "index", intersect: false },
      plugins: {
        tooltip: {
          callbacks: {
            title: (items) => `${items[0].label} workload hours / month`,
            label: (c) => `${c.dataset.label}: ${formatMoneyFull(c.raw)}`,
          },
        },
      },
      scales: {
        x: { title: { display: true, text: `Workload hours per month (at ${vcpus} vCPUs)` } },
        y: { ticks: { callback: (v) => formatMoney(v) } },
      },
    },
  });

  const note = document.getElementById("breakevenNote");
  if (vcpus === 0 || rates.avgCpu === 0) {
    note.textContent = "Set vCPUs allocated and a SageMaker rate to see breakeven.";
    return;
  }
  const breakevenHours = (ocpTotal - smFixed) / (vcpus * rates.avgCpu);
  if (breakevenHours <= 0) {
    note.innerHTML = `SageMaker fixed costs already exceed OpenShift AI total — OpenShift AI wins at every workload hour count.`;
    return;
  }
  note.innerHTML =
    `Breakeven: <strong>${Math.round(breakevenHours).toLocaleString()} workload hours / month</strong> ` +
    `at ${vcpus} vCPUs. Below that, SageMaker wins; above, OpenShift AI wins.`;
}

function renderSummary(sm, ocp, inputs) {
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
      verdictText = `At this workload, SageMaker is ~${Math.round(((ocpMonthly - smMonthly) / ocpMonthly) * 100)}% cheaper per month. The on-prem cluster only pays off at higher sustained utilization.`;
    } else {
      verdictClass = "openshift";
      verdictText = `At this workload, OpenShift AI is ~${Math.round(((smMonthly - ocpMonthly) / smMonthly) * 100)}% cheaper per month. Sustained utilization is amortizing the cluster well.`;
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
        <div class="label">OCP cluster${inputs.manualSizing ? " (manual)" : " (auto)"}</div>
        <div class="value">${ocp.servers} srv / ${ocp.clusterVcpus} vCPU</div>
      </div>
      <div class="summary-card">
        <div class="label">OCP effective $/vCPU-hr @ ${inputs.utilPct}%</div>
        <div class="value">$${ocp.effectivePerVcpuHour.toFixed(4)}</div>
      </div>
    </div>
    ${ocp.undersized ? `<div class="verdict openshift"><strong>Warning:</strong> manually sized cluster has ${ocp.clusterVcpus} vCPU but workload + workbench demand is ${ocp.totalDemand} vCPU. Costs shown reflect the cluster you specified; it cannot actually run the workload as configured.</div>` : ""}
    <div class="verdict ${verdictClass}">${verdictText}</div>
    <details style="margin-top: 0.75rem;">
      <summary>Monthly cost breakdown (both sides)</summary>
      <div class="breakdown-grid">
        <div>
          <strong>SageMaker</strong>
          <ul>
            <li>Compute (workload vCPU-hours): ${formatMoneyFull(sm.compute)}</li>
            <li>Notebook workspaces: ${formatMoneyFull(sm.notebooks)}</li>
            <li>S3 storage: ${formatMoneyFull(sm.storage)}</li>
            <li>Data egress: ${formatMoneyFull(sm.egress)}</li>
          </ul>
        </div>
        <div>
          <strong>OpenShift AI</strong>
          <ul>
            <li>Cluster hardware (amortized): ${formatMoneyFull(ocp.breakdown.hardware)}</li>
            <li>Subscriptions (OCP Platform Plus): ${formatMoneyFull(ocp.breakdown.subscriptions)}</li>
            <li>Power + cooling (PUE applied): ${formatMoneyFull(ocp.breakdown.power)}</li>
            <li>Ops overhead: ${formatMoneyFull(ocp.breakdown.ops)}</li>
            <li>Storage: ${formatMoneyFull(ocp.breakdown.storage)}</li>
            <li>Data egress: ${formatMoneyFull(ocp.breakdown.egress)}</li>
          </ul>
          <small>Cluster cost is allocated to Compute (${formatMoneyFull(ocp.compute)}) and Workspaces (${formatMoneyFull(ocp.notebooks)}) by vCPU demand.</small>
        </div>
      </div>
    </details>
  `;
  document.getElementById("summary").innerHTML = html;
}

function renderInstanceList(prices) {
  const el = document.getElementById("instanceList");
  const row = (i) =>
    `<div class="row"><span>${i.type} · ${i.vcpus} vCPU</span><span>$${i.pricePerHour.toFixed(3)}/hr · $${(i.pricePerHour / i.vcpus).toFixed(4)}/vCPU-hr</span></div>`;
  const list = prices.instances || [];
  el.innerHTML = list.map(row).join("");
}

function update() {
  const inputs = readInputs();
  const rates = { avgCpu: state.avgCpu };
  const sm = computeSageMaker(inputs, rates);
  const ocp = computeOpenShift(inputs);

  document.getElementById("avgCpuRate").textContent = state.avgCpu > 0
    ? `$${state.avgCpu.toFixed(4)}/vCPU-hr`
    : "—";

  renderMonthlyChart(sm, ocp);
  renderTcoChart(sm, ocp, inputs.amortYears);
  renderSweepChart(inputs, rates, sm, ocp);
  renderSummary(sm, ocp, inputs);
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
    state.avgCpu = avgs.avgCpu;

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
