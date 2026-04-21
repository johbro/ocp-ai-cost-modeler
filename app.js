const HOURS_PER_YEAR = 8760;
const HOURS_PER_MONTH = 730;

const state = {
  prices: null,
  avgTrain: 0,
  avgInf: 0,
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
  const gpuOnly = (arr) => arr.filter((i) => i.gpus && i.gpus > 0);
  const perGpuTrain = gpuOnly(prices.instances.training).map((i) => i.pricePerHour / i.gpus);
  const perGpuInf = gpuOnly(prices.instances.inference).map((i) => i.pricePerHour / i.gpus);
  const cpuList = prices.instances.cpu || [];
  const perVcpu = cpuList.filter((i) => i.vcpus && i.vcpus > 0).map((i) => i.pricePerHour / i.vcpus);
  return {
    avgTrain: average(perGpuTrain),
    avgInf: average(perGpuInf),
    avgCpu: average(perVcpu),
  };
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

const GB_PER_TB = 1000;

function readInputs() {
  const num = (id) => parseFloat(document.getElementById(id).value) || 0;
  const bool = (id) => document.getElementById(id).checked;
  return {
    trainGpus: num("trainGpus"),
    trainHours: num("trainHours"),
    infGpus: num("infGpus"),
    infHours: num("infHours"),
    sharedPool: bool("sharedPool"),
    serverCost: num("serverCost"),
    gpusPerServer: Math.max(1, num("gpusPerServer")),
    manualSizing: bool("manualSizing"),
    clusterServers: Math.max(1, num("clusterServers")),
    amortYears: Math.max(1, num("amortYears")),
    ocpSubPerServer: num("ocpSubPerServer"),
    ocpAiPerGpu: num("ocpAiPerGpu"),
    kwPerServer: num("kwPerServer"),
    kwhCost: num("kwhCost"),
    pue: Math.max(1, num("pue")),
    opsPct: num("opsPct"),
    utilPct: Math.max(1, Math.min(100, num("utilPct"))),
    userCount: num("userCount"),
    userHours: num("userHours"),
    smNotebookRate: num("smNotebookRate"),
    ocpWorkbenchShared: bool("ocpWorkbenchShared"),
    ocpWorkbenchPerUser: num("ocpWorkbenchPerUser"),
    storageTb: num("storageTb"),
    egressTb: num("egressTb"),
    smStorageRate: num("smStorageRate"),
    smEgressRate: num("smEgressRate"),
    ocpStorageRate: num("ocpStorageRate"),
    ocpEgressRate: num("ocpEgressRate"),
    cpuCount: num("cpuCount"),
    cpuHours: num("cpuHours"),
    ocpCpuShared: bool("ocpCpuShared"),
    ocpCpuRate: num("ocpCpuRate"),
    nonGpuEnabled: bool("nonGpuEnabled"),
    nonGpuServerCost: num("nonGpuServerCost"),
    nonGpuVcpusPerServer: Math.max(1, num("nonGpuVcpusPerServer")),
    nonGpuManualSizing: bool("nonGpuManualSizing"),
    nonGpuServers: Math.max(1, num("nonGpuServers")),
    nonGpuSubPerServer: num("nonGpuSubPerServer"),
    nonGpuKwPerServer: num("nonGpuKwPerServer"),
    nbVcpusPerUser: Math.max(1, num("nbVcpusPerUser")),
  };
}

function computeSageMaker(i, rates) {
  const train = i.trainGpus * i.trainHours * rates.avgTrain;
  const inference = i.infGpus * i.infHours * rates.avgInf;
  const cpu = i.cpuCount * i.cpuHours * rates.avgCpu;
  const notebooks = i.userCount * i.userHours * i.smNotebookRate;
  const storage = i.storageTb * GB_PER_TB * i.smStorageRate;
  const egress = i.egressTb * GB_PER_TB * i.smEgressRate;
  const gpuCompute = train + inference;
  const total = gpuCompute + cpu + notebooks + storage + egress;
  return { train, inference, gpuCompute, cpu, notebooks, storage, egress, total };
}

function computeNonGpuCluster(i) {
  if (!i.nonGpuEnabled) return null;

  const cpuOnNonGpu = !i.ocpCpuShared;
  const nbOnNonGpu = !i.ocpWorkbenchShared;
  const cpuDemand = cpuOnNonGpu ? i.cpuCount : 0;
  const nbDemand = nbOnNonGpu ? i.userCount * i.nbVcpusPerUser : 0;
  const totalDemand = cpuDemand + nbDemand;

  const autoServers = Math.max(1, Math.ceil(totalDemand / i.nonGpuVcpusPerServer));
  const servers = i.nonGpuManualSizing ? i.nonGpuServers : autoServers;
  const clusterVcpus = servers * i.nonGpuVcpusPerServer;
  const undersized = i.nonGpuManualSizing && totalDemand > clusterVcpus;

  const capex = servers * i.nonGpuServerCost;
  const hardwareAnnual = capex / i.amortYears;
  const subsAnnual = servers * i.nonGpuSubPerServer;
  const powerAnnual = servers * i.nonGpuKwPerServer * HOURS_PER_YEAR * i.kwhCost * i.pue;
  const opsAnnual = capex * (i.opsPct / 100);
  const monthly = (hardwareAnnual + subsAnnual + powerAnnual + opsAnnual) / 12;

  let cpuShare = 0;
  let nbShare = 0;
  if (totalDemand > 0) {
    cpuShare = cpuDemand / totalDemand;
    nbShare = nbDemand / totalDemand;
  } else if (cpuOnNonGpu) {
    cpuShare = 1;
  } else if (nbOnNonGpu) {
    nbShare = 1;
  } else {
    cpuShare = 1;
  }

  return {
    enabled: true,
    servers,
    clusterVcpus,
    totalDemand,
    undersized,
    monthly,
    cpuAllocation: monthly * cpuShare,
    nbAllocation: monthly * nbShare,
    breakdown: {
      hardware: hardwareAnnual / 12,
      subscriptions: subsAnnual / 12,
      power: powerAnnual / 12,
      ops: opsAnnual / 12,
    },
  };
}

function computeOpenShift(i) {
  const peakGpus = i.sharedPool
    ? Math.max(i.trainGpus, i.infGpus)
    : i.trainGpus + i.infGpus;

  const storage = i.storageTb * i.ocpStorageRate;
  const egress = i.egressTb * GB_PER_TB * i.ocpEgressRate;

  const nonGpu = computeNonGpuCluster(i);
  let notebooks = 0;
  if (!i.ocpWorkbenchShared) {
    notebooks = nonGpu ? nonGpu.nbAllocation : i.userCount * i.ocpWorkbenchPerUser;
  }
  let cpu = 0;
  if (!i.ocpCpuShared) {
    cpu = nonGpu ? nonGpu.cpuAllocation : i.cpuCount * i.cpuHours * i.ocpCpuRate;
  }

  const autoServers = Math.max(1, Math.ceil(peakGpus / i.gpusPerServer));
  const servers = i.manualSizing ? i.clusterServers : autoServers;
  const clusterGpus = servers * i.gpusPerServer;
  const undersized = i.manualSizing && peakGpus > clusterGpus;

  if (peakGpus === 0 && !i.manualSizing) {
    const monthly = storage + egress + notebooks + cpu;
    return {
      peakGpus: 0, servers: 0, clusterGpus: 0, undersized: false,
      annual: monthly * 12, monthly, tco: monthly * 12 * i.amortYears,
      effectivePerGpuHour: 0,
      gpuCompute: 0, cpu, notebooks, storage, egress,
      nonGpu,
      breakdown: { hardware: 0, subscriptions: 0, power: 0, ops: 0, cpu, notebooks, storage, egress },
    };
  }

  const capex = servers * i.serverCost;
  const hardwareAnnual = capex / i.amortYears;
  const subsAnnual = servers * i.ocpSubPerServer + clusterGpus * i.ocpAiPerGpu;
  const powerAnnual = servers * i.kwPerServer * HOURS_PER_YEAR * i.kwhCost * i.pue;
  const opsAnnual = capex * (i.opsPct / 100);

  const gpuComputeAnnual = hardwareAnnual + subsAnnual + powerAnnual + opsAnnual;
  const gpuCompute = gpuComputeAnnual / 12;
  const monthly = gpuCompute + cpu + notebooks + storage + egress;
  const annual = monthly * 12;
  const tco = annual * i.amortYears;

  const effectiveGpuHours = clusterGpus * HOURS_PER_YEAR * (i.utilPct / 100);
  const effectivePerGpuHour = effectiveGpuHours > 0 ? gpuComputeAnnual / effectiveGpuHours : 0;

  return {
    peakGpus, servers, clusterGpus, undersized,
    annual, monthly, tco,
    effectivePerGpuHour,
    gpuCompute, cpu, notebooks, storage, egress,
    nonGpu,
    breakdown: {
      hardware: hardwareAnnual / 12,
      subscriptions: subsAnnual / 12,
      power: powerAnnual / 12,
      ops: opsAnnual / 12,
      cpu,
      notebooks,
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

const CATEGORIES = ["GPU compute", "CPU compute", "Workspaces", "Storage", "Egress", "Total"];

function smCategories(sm) {
  return [sm.gpuCompute, sm.cpu, sm.notebooks, sm.storage, sm.egress, sm.total];
}

function ocpCategories(ocp) {
  return [ocp.gpuCompute, ocp.cpu, ocp.notebooks, ocp.storage, ocp.egress, ocp.monthly];
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
  const totalGpus = inputs.trainGpus + inputs.infGpus;
  const blendedRate = totalGpus > 0
    ? (inputs.trainGpus * rates.avgTrain + inputs.infGpus * rates.avgInf) / totalGpus
    : 0;

  // Fixed costs that don't scale with GPU-hours — shift both curves up.
  const smFixed = sm.cpu + sm.notebooks + sm.storage + sm.egress;
  const ocpFixed = ocp.monthly;

  const maxHours = Math.max(HOURS_PER_MONTH, (inputs.trainHours + inputs.infHours) * 1.5, 100);
  const steps = 40;
  const labels = [];
  const sageLine = [];
  const ocpLine = [];
  for (let s = 0; s <= steps; s++) {
    const h = (maxHours * s) / steps;
    labels.push(Math.round(h));
    sageLine.push(smFixed + h * totalGpus * blendedRate);
    ocpLine.push(ocpFixed);
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
  const breakevenGpuHours = (ocpFixed - smFixed) / (totalGpus * blendedRate);
  if (breakevenGpuHours <= 0) {
    note.innerHTML = `SageMaker fixed costs already exceed OpenShift AI total — OpenShift AI wins at every GPU-hour count.`;
    return;
  }
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
        <div class="label">OCP GPU cluster${inputs.manualSizing ? " (manual)" : " (auto)"}</div>
        <div class="value">${ocp.servers} srv / ${ocp.clusterGpus} GPU</div>
      </div>
      ${ocp.nonGpu ? `
      <div class="summary-card">
        <div class="label">OCP non-GPU cluster${inputs.nonGpuManualSizing ? " (manual)" : " (auto)"}</div>
        <div class="value">${ocp.nonGpu.servers} srv / ${ocp.nonGpu.clusterVcpus} vCPU</div>
      </div>` : ""}
      <div class="summary-card">
        <div class="label">OCP effective $/GPU-hr @ ${inputs.utilPct}%</div>
        <div class="value">$${ocp.effectivePerGpuHour.toFixed(2)}</div>
      </div>
    </div>
    ${ocp.undersized ? `<div class="verdict openshift"><strong>GPU cluster warning:</strong> manually sized cluster has ${ocp.clusterGpus} GPUs but workload peak needs ${ocp.peakGpus}.</div>` : ""}
    ${ocp.nonGpu && ocp.nonGpu.undersized ? `<div class="verdict openshift"><strong>Non-GPU cluster warning:</strong> manually sized cluster has ${ocp.nonGpu.clusterVcpus} vCPU but CPU + notebook demand is ${ocp.nonGpu.totalDemand} vCPU.</div>` : ""}
    <div class="verdict ${verdictClass}">${verdictText}</div>
    <details style="margin-top: 0.75rem;">
      <summary>Monthly cost breakdown (both sides)</summary>
      <div class="breakdown-grid">
        <div>
          <strong>SageMaker</strong>
          <ul>
            <li>GPU training: ${formatMoneyFull(sm.train)}</li>
            <li>GPU inference: ${formatMoneyFull(sm.inference)}</li>
            <li>CPU compute: ${formatMoneyFull(sm.cpu)}</li>
            <li>Notebook workspaces: ${formatMoneyFull(sm.notebooks)}</li>
            <li>S3 storage: ${formatMoneyFull(sm.storage)}</li>
            <li>Data egress: ${formatMoneyFull(sm.egress)}</li>
          </ul>
        </div>
        <div>
          <strong>OpenShift AI</strong>
          <ul>
            <li>GPU cluster hardware (amortized): ${formatMoneyFull(ocp.breakdown.hardware)}</li>
            <li>Subscriptions (OCP + OAI): ${formatMoneyFull(ocp.breakdown.subscriptions)}</li>
            <li>Power + cooling (PUE applied): ${formatMoneyFull(ocp.breakdown.power)}</li>
            <li>Ops overhead: ${formatMoneyFull(ocp.breakdown.ops)}</li>
            ${ocp.nonGpu ? `<li>Non-GPU cluster total: ${formatMoneyFull(ocp.nonGpu.monthly)} <em>(hw ${formatMoneyFull(ocp.nonGpu.breakdown.hardware)} + subs ${formatMoneyFull(ocp.nonGpu.breakdown.subscriptions)} + power ${formatMoneyFull(ocp.nonGpu.breakdown.power)} + ops ${formatMoneyFull(ocp.nonGpu.breakdown.ops)})</em></li>` : ""}
            <li>CPU compute: ${formatMoneyFull(ocp.breakdown.cpu)}${inputs.ocpCpuShared ? " <em>(absorbed by GPU cluster)</em>" : ocp.nonGpu ? " <em>(allocated from non-GPU cluster)</em>" : ""}</li>
            <li>Workbench workspaces: ${formatMoneyFull(ocp.breakdown.notebooks)}${inputs.ocpWorkbenchShared ? " <em>(absorbed by GPU cluster)</em>" : ocp.nonGpu ? " <em>(allocated from non-GPU cluster)</em>" : ""}</li>
            <li>Storage: ${formatMoneyFull(ocp.breakdown.storage)}</li>
            <li>Data egress: ${formatMoneyFull(ocp.breakdown.egress)}</li>
          </ul>
        </div>
      </div>
    </details>
  `;
  document.getElementById("summary").innerHTML = html;
}

function renderInstanceList(prices) {
  const el = document.getElementById("instanceList");
  const gpuRow = (i) => {
    const gpus = i.gpus || 0;
    const perGpu = gpus > 0 ? `$${(i.pricePerHour / gpus).toFixed(3)}/GPU-hr` : "—";
    return `<div class="row"><span>${i.type} · ${gpus}× ${i.gpuModel || "?"}</span><span>$${i.pricePerHour.toFixed(3)}/hr · ${perGpu}</span></div>`;
  };
  const cpuRow = (i) =>
    `<div class="row"><span>${i.type} · ${i.vcpus} vCPU</span><span>$${i.pricePerHour.toFixed(3)}/hr · $${(i.pricePerHour / i.vcpus).toFixed(4)}/vCPU-hr</span></div>`;
  const cpuList = prices.instances.cpu || [];
  el.innerHTML =
    `<div style="margin-top:0.5rem;color:var(--text)"><strong>GPU training</strong></div>` +
    prices.instances.training.map(gpuRow).join("") +
    `<div style="margin-top:0.5rem;color:var(--text)"><strong>GPU real-time inference</strong></div>` +
    prices.instances.inference.map(gpuRow).join("") +
    (cpuList.length
      ? `<div style="margin-top:0.5rem;color:var(--text)"><strong>CPU instances</strong></div>` +
        cpuList.map(cpuRow).join("")
      : "");
}

function update() {
  const inputs = readInputs();
  const rates = { avgTrain: state.avgTrain, avgInf: state.avgInf, avgCpu: state.avgCpu };
  const sm = computeSageMaker(inputs, rates);
  const ocp = computeOpenShift(inputs);

  document.getElementById("avgTrainRate").textContent = `$${state.avgTrain.toFixed(3)}/GPU-hr`;
  document.getElementById("avgInfRate").textContent = `$${state.avgInf.toFixed(3)}/GPU-hr`;
  document.getElementById("avgCpuRate").textContent = state.avgCpu > 0
    ? `$${state.avgCpu.toFixed(4)}/vCPU-hr`
    : "—";

  renderMonthlyChart(sm, ocp);
  renderTcoChart(sm, ocp, inputs.amortYears);
  renderSweepChart(inputs, rates, sm, ocp);
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
