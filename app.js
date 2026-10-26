(() => {
  const money = (paise) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(paise / 100);
  const safeDate = (date) => new Date(date).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  let state = { customers: [], transactions: [] };
  let sampleMode = false;
  let toastTimer;
  let pendingVoiceLanguage = null;
  let queuedVoiceMessage = null;
  let conversationHistory = [];
  let lastFailedMessage = null;
  let activeRecorder = null;
  let activeStream = null;
  let recordingTimeout = null;
  let currentAudioUrl = null;
  let spacebarHeld = false;
  const $ = (selector) => document.querySelector(selector);
  const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const request = async (path, options = {}) => {
    let response;
    try {
      response = await fetch(path, { credentials: "same-origin", ...options });
    } catch {
      throw new Error("Network connection lost. Check your connection and retry.");
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Request failed. Please retry.");
    return result;
  };
  const postJson = (path, body) => request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(path === "/.netlify/functions/ledger"
      ? { ...body, dataset: sampleMode ? "sample" : "main" }
      : body)
  });
  const ledgerPath = () => `/.netlify/functions/ledger${sampleMode ? "?dataset=sample" : ""}`;
  const balanceFor = (customerId) => state.transactions.reduce((balance, tx) => {
    if (tx.customerId !== customerId) return balance;
    return balance + (tx.type === "credit" ? tx.amountPaise : -tx.amountPaise);
  }, 0);
  $("#todayDate").textContent = new Date().toLocaleDateString("en-IN", { weekday: "long", year: "numeric", month: "long", day: "numeric" }).toLocaleUpperCase();
  const showToast = (message) => {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("visible"), 3000);
  };
  const loadLedger = async () => {
    state = await request(ledgerPath());
    render();
  };
  const switchDataset = async (showSample) => {
    const previous = sampleMode;
    sampleMode = showSample;
    $("#sampleBanner").hidden = !sampleMode;
    $("#sampleDataButton").hidden = sampleMode;
    $("#addCustomerTop").textContent = sampleMode ? "＋ Add sample customer" : "＋ Add customer";
    $("#addExpenseTop").textContent = sampleMode ? "＋ Add sample expense" : "＋ Add expense";
    try {
      await loadLedger();
    } catch (error) {
      sampleMode = previous;
      $("#sampleBanner").hidden = !sampleMode;
      $("#sampleDataButton").hidden = sampleMode;
      $("#addCustomerTop").textContent = sampleMode ? "＋ Add sample customer" : "＋ Add customer";
      $("#addExpenseTop").textContent = sampleMode ? "＋ Add sample expense" : "＋ Add expense";
      showToast(error instanceof Error ? error.message : "Could not switch ledgers.");
    }
  };
  const showErrorWithRetry = (message, retry) => {
    const wrapper = document.createElement("div");
    wrapper.className = "chat-message assistant";
    wrapper.innerHTML = '<span class="message-avatar">उ</span><div class="bubble"><p></p></div>';
    wrapper.querySelector("p").textContent = message;
    const button = document.createElement("button");
    button.className = "retry-button";
    button.type = "button";
    button.textContent = "Retry";
    button.addEventListener("click", retry, { once: true });
    wrapper.querySelector(".bubble").append(button);
    $("#chatBody").append(wrapper);
    $("#chatBody").scrollTop = $("#chatBody").scrollHeight;
  };
  const render = () => {
    const now = Date.now();
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const recent = state.transactions.filter((tx) => new Date(tx.createdAt).getTime() >= weekAgo);
    const sales = state.transactions.filter((tx) => tx.type === "credit");
    const knownCosts = sales.filter((tx) => Number.isSafeInteger(tx.costPaise));
    const expenses = Array.isArray(state.expenses) ? state.expenses : [];
    const recordedProfit = sales.reduce((sum, tx) => sum + tx.amountPaise, 0)
      - knownCosts.reduce((sum, tx) => sum + tx.costPaise, 0)
      - expenses.reduce((sum, expense) => sum + expense.amountPaise, 0);
    $("#totalOutstanding").textContent = money(state.customers.reduce((sum, customer) => sum + Math.max(balanceFor(customer.id), 0), 0));
    $("#creditWeek").textContent = money(recent.filter((tx) => tx.type === "credit").reduce((sum, tx) => sum + tx.amountPaise, 0));
    $("#paymentsWeek").textContent = money(recent.filter((tx) => tx.type === "payment").reduce((sum, tx) => sum + tx.amountPaise, 0));
    $("#owingCount").textContent = state.customers.filter((customer) => balanceFor(customer.id) > 0).length;
    $("#customerCount").textContent = state.customers.length;
    $("#totalProfit").textContent = money(recordedProfit);
    const costsMissing = sales.length - knownCosts.length;
    $("#profitNote").textContent = costsMissing
      ? `Item cost missing on ${costsMissing} sale${costsMissing === 1 ? "" : "s"}; actual profit may be lower`
      : "Based only on recorded costs and expenses";
    renderCustomers();
    renderActivity();
  };
  const renderCustomers = () => {
    const query = $("#customerSearch").value.trim().toLocaleLowerCase();
    const customers = [...state.customers]
      .filter((customer) => `${customer.name} ${customer.phone}`.toLocaleLowerCase().includes(query))
      .sort((a, b) => balanceFor(b.id) - balanceFor(a.id));
    $("#customerList").innerHTML = customers.length ? customers.map((customer) => {
      const balance = balanceFor(customer.id);
      const initials = customer.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toLocaleUpperCase();
      const balanceLabel = balance < 0 ? `Advance ${money(Math.abs(balance))}` : money(balance);
      return `<div class="customer-row" data-customer="${escapeHtml(customer.id)}" tabindex="0" role="button" aria-label="View ${escapeHtml(customer.name)} ledger">
        <span class="customer-avatar">${escapeHtml(initials)}</span>
        <span class="customer-details"><strong class="customer-name">${escapeHtml(customer.name)}</strong><small>${escapeHtml(customer.phone || "Customer")}</small></span>
        <span class="customer-balance ${balance < 0 ? "advance" : balance === 0 ? "zero" : ""}">${balanceLabel}</span>
      </div>`;
    }).join("") : `<p class="empty-state">No customers found.</p>`;
  };
  const transactionRow = (tx) => {
    const customer = state.customers.find((item) => item.id === tx.customerId);
    const isExpense = tx.type === "expense";
    const isCredit = tx.type === "credit";
    return `<div class="activity-row">
      <span class="activity-icon ${isCredit ? "credit" : "payment"}">${isCredit ? "↗" : "↓"}</span>
      <span class="activity-copy"><strong>${escapeHtml(isExpense ? "Shop expense" : customer?.name || "Unknown customer")}</strong><small>${isExpense ? "Expense" : isCredit ? "Credit / sale" : "Payment"}${tx.description ? ` · ${escapeHtml(tx.description)}` : ""} · ${safeDate(tx.createdAt)}</small></span>
      <span class="activity-amount ${isCredit ? "credit" : "payment"}">${isCredit ? "+" : "−"}${money(tx.amountPaise)}</span>
    </div>`;
  };
  const renderActivity = () => {
    const entries = [...state.transactions, ...(state.expenses || []).map((expense) => ({ ...expense, type: "expense" }))]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 6);
    $("#activityList").innerHTML = entries.length ? entries.map(transactionRow).join("") : `<p class="empty-state">No entries yet. Add a customer transaction to get started.</p>`;
  };
  const openCustomerDialog = () => {
    $("#customerError").classList.remove("visible");
    $("#customerForm").reset();
    delete $("#customerForm").dataset.requestId;
    $("#customerDialog").showModal();
    $("#customerName").focus();
  };
  const openTransactionDialog = (customerId = "", type = "credit") => {
    if (!state.customers.length) {
      showToast("Add a customer before recording an entry.");
      openCustomerDialog();
      return;
    }
    $("#transactionForm").reset();
    delete $("#transactionForm").dataset.requestId;
    $("#transactionError").classList.remove("visible");
    $("#costField").hidden = type !== "credit";
    $("#transactionCustomer").innerHTML = state.customers.map((customer) => `<option value="${escapeHtml(customer.id)}">${escapeHtml(customer.name)} · ${money(balanceFor(customer.id))}</option>`).join("");
    if (customerId && state.customers.some((customer) => customer.id === customerId)) $("#transactionCustomer").value = customerId;
    $("#transactionType").value = type;
    $("#transactionDialog").showModal();
    $("#transactionCustomer").focus();
  };
  const openHistory = (customerId) => {
    const customer = state.customers.find((item) => item.id === customerId);
    if (!customer) return;
    $("#historyTitle").textContent = customer.name;
    const balance = balanceFor(customer.id);
    $("#historyBalance").textContent = balance < 0
      ? `Advance balance: ${money(Math.abs(balance))}`
      : `Outstanding balance: ${money(balance)}`;
    const transactions = [...state.transactions.filter((tx) => tx.customerId === customer.id)]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    $("#historyList").innerHTML = transactions.length ? transactions.map(transactionRow).join("") : `<p class="empty-state">No entries for this customer yet.</p>`;
    $("#historyAddCredit").dataset.customer = customer.id;
    $("#historyDialog").showModal();
  };
  const addTransaction = async (customerId, type, amountPaise, description = "", requestId = crypto.randomUUID(), costPaise = null) => {
    const result = await postJson("/.netlify/functions/ledger", {
      action: "create_transaction",
      customerId,
      type,
      amountPaise,
      costPaise,
      description,
      requestId
    });
    state = { customers: result.customers, transactions: result.transactions, expenses: result.expenses || [] };
    render();
    return result.balancePaise;
  };
  const appendMessage = (text, role = "assistant") => {
    const wrapper = document.createElement("div");
    wrapper.className = `chat-message ${role}`;
    const avatar = role === "assistant" ? `<span class="message-avatar">उ</span>` : "";
    wrapper.innerHTML = `${avatar}<div class="bubble"><p></p><span class="message-time">${role === "assistant" ? "UdhaarOS" : "You"}</span></div>`;
    wrapper.querySelector("p").textContent = text;
    $("#chatBody").append(wrapper);
    $("#chatBody").scrollTop = $("#chatBody").scrollHeight;
  };
  const resolveCustomer = (name) => {
    if (typeof name !== "string" || !name.trim()) return { error: "Kis customer ka naam hai? Please customer ka naam batayein." };
    const needle = name.trim().toLocaleLowerCase();
    const exactMatches = state.customers.filter((customer) => customer.name.toLocaleLowerCase() === needle);
    const matches = exactMatches.length ? exactMatches : state.customers.filter((customer) => {
      const customerName = customer.name.toLocaleLowerCase();
      return customerName.startsWith(`${needle} `) || customerName.split(/\s+/).includes(needle);
    });
    if (matches.length === 1) return { customer: matches[0] };
    if (matches.length > 1) return { error: `"${name}" naam ke kai customers hain. Customer list se sahi naam select karein.` };
    return { notFound: true, error: `"${name}" customer nahi mila.` };
  };
  const interpretLocally = async (message, history) => {
    return postJson("/.netlify/functions/agent", { message, history, dataset: sampleMode ? "sample" : "main" });
  };
  const handleAgent = async (message, requestId, history) => {
    const result = await interpretLocally(message, history);
    if (result.needs_clarification || result.intent === "clarify") return result.reply || "Thoda aur detail batayein—kaunsa customer aur kitne rupaye?";
    const { intent, customer_name: customerName, amount_paise: amount, description } = result;
    if (intent === "add_customer") {
      if (!customerName?.trim()) return result.reply || "Customer ka naam batayein, phir main unhe add kar dunga.";
      const added = await postJson("/.netlify/functions/ledger", {
        action: "create_customer",
        name: customerName,
        requestId
      });
      state = { customers: added.customers, transactions: added.transactions, expenses: added.expenses || [] };
      render();
      return `${customerName} customer list mein add ho gaye.`;
    }
    if (intent === "record_expense") {
      if (!Number.isSafeInteger(amount) || amount <= 0) return result.reply || "Expense ka amount batayein.";
      const added = await postJson("/.netlify/functions/ledger", {
        action: "create_expense",
        amountPaise: amount,
        description: description || "Shop expense",
        requestId
      });
      state.expenses = added.expenses || [];
      render();
      return `${money(amount)} ka shop expense "${description || "Shop expense"}" save hua.`;
    }
    if (intent === "get_profit") {
      const sales = state.transactions.filter((tx) => tx.type === "credit");
      const recordedCosts = sales.filter((tx) => Number.isSafeInteger(tx.costPaise));
      const expenses = Array.isArray(state.expenses) ? state.expenses : [];
      const salesTotal = sales.reduce((sum, tx) => sum + tx.amountPaise, 0);
      const costTotal = recordedCosts.reduce((sum, tx) => sum + tx.costPaise, 0);
      const expenseTotal = expenses.reduce((sum, expense) => sum + expense.amountPaise, 0);
      const estimate = salesTotal - costTotal - expenseTotal;
      const missingCosts = sales.length - recordedCosts.length;
      return `All-time recorded profit estimate: ${money(estimate)}.\nSales recorded: ${money(salesTotal)}\nItem costs recorded: ${money(costTotal)}\nShop expenses recorded: ${money(expenseTotal)}\n${missingCosts ? `Purchase cost is missing for ${missingCosts} sale(s), so actual profit may be lower.` : "All sale item costs are recorded; unrecorded shop costs are not included."}`;
    }
    if (intent === "list_top_debtors") {
      const debtors = state.customers.map((customer) => ({ customer, balance: balanceFor(customer.id) })).filter((row) => row.balance > 0).sort((a, b) => b.balance - a.balance).slice(0, 3);
      return debtors.length ? `Sabse zyada udhaar:\n${debtors.map((row, index) => `${index + 1}. ${row.customer.name} — ${money(row.balance)}`).join("\n")}` : "Abhi kisi customer ka outstanding balance nahi hai.";
    }
    if (intent === "get_summary") {
      const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const week = state.transactions.filter((tx) => new Date(tx.createdAt).getTime() >= weekAgo);
      const credits = week.filter((tx) => tx.type === "credit").reduce((sum, tx) => sum + tx.amountPaise, 0);
      const payments = week.filter((tx) => tx.type === "payment").reduce((sum, tx) => sum + tx.amountPaise, 0);
      const due = state.customers.reduce((sum, customer) => sum + Math.max(balanceFor(customer.id), 0), 0);
      const weekExpenses = (state.expenses || []).filter((expense) => new Date(expense.createdAt).getTime() >= weekAgo);
      const expenseTotal = weekExpenses.reduce((sum, expense) => sum + expense.amountPaise, 0);
      const weekCosts = week.filter((tx) => tx.type === "credit" && Number.isSafeInteger(tx.costPaise));
      const profit = credits - weekCosts.reduce((sum, tx) => sum + tx.costPaise, 0) - expenseTotal;
      const missingCosts = week.filter((tx) => tx.type === "credit" && !Number.isSafeInteger(tx.costPaise)).length;
      return `Pichhle 7 din ka hisaab:\nSales: ${money(credits)}\nPayment mila: ${money(payments)}\nShop expenses: ${money(expenseTotal)}\nRecorded profit estimate: ${money(profit)}${missingCosts ? ` · cost missing for ${missingCosts} sale(s), so actual may be lower` : ""}\nTotal outstanding: ${money(due)}`;
    }
    if (intent === "list_customers") return state.customers.length ? `Customers (${state.customers.length}):\n${state.customers.map((customer) => `${customer.name} — ${money(balanceFor(customer.id))}`).join("\n")}` : "Abhi koi customer nahi hai.";
    if (intent === "chat" || intent === "unknown") return result.reply || "Hisaab, customer stats, profit, ya dukaan ke kisi sawaal mein madad chahiye?";
    const isTransaction = intent === "add_credit" || intent === "record_payment";
    const resolved = resolveCustomer(customerName);
    if (resolved.error && !(resolved.notFound && isTransaction)) return resolved.error;
    if (intent === "get_balance") {
      const customer = resolved.customer;
      const balance = balanceFor(customer.id);
      return balance < 0
        ? `${customer.name} ke account mein ${money(Math.abs(balance))} advance jama hai.`
        : `${customer.name} ka baaki: ${money(balance)}.`;
    }
    if (intent === "get_customer_history" || intent === "get_customer_stats") {
      const customer = resolved.customer;
      const records = state.transactions.filter((tx) => tx.customerId === customer.id).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      const sales = records.filter((tx) => tx.type === "credit");
      const payments = records.filter((tx) => tx.type === "payment");
      const creditTotal = sales.reduce((sum, tx) => sum + tx.amountPaise, 0);
      const paymentTotal = payments.reduce((sum, tx) => sum + tx.amountPaise, 0);
      const balance = balanceFor(customer.id);
      const costKnown = sales.filter((tx) => Number.isSafeInteger(tx.costPaise));
      const knownMargin = costKnown.reduce((sum, tx) => sum + tx.amountPaise - tx.costPaise, 0);
      const recentRecords = records.slice(0, 20);
      const entries = recentRecords.map((tx) => `${tx.type === "credit" ? "Sale/udhaar" : "Payment"} ${money(tx.amountPaise)}${tx.description ? ` · ${tx.description}` : ""} (${safeDate(tx.createdAt)})`).join("\n");
      const history = records.length
        ? `\nLatest ${recentRecords.length}${records.length > recentRecords.length ? ` of ${records.length}` : ""} entries:\n${entries}`
        : "\nNo transactions recorded.";
      return `${customer.name} ka customer report:\nSales/udhaar: ${money(creditTotal)} (${sales.length} entries)\nPayments received: ${money(paymentTotal)} (${payments.length} entries)\n${balance < 0 ? `Advance balance: ${money(Math.abs(balance))}` : `Outstanding balance: ${money(balance)}`}\nKnown item costs: ${money(costKnown.reduce((sum, tx) => sum + tx.costPaise, 0))}\nRecorded gross margin on costed sales: ${money(knownMargin)}${costKnown.length < sales.length ? `; item cost missing on ${sales.length - costKnown.length} sale(s)` : ""}${history}`;
    }
    if (intent !== "add_credit" && intent !== "record_payment") return result.reply || "Yeh request samajh nahi aayi. Try karein: “Ramesh ka balance batao.”";
    if (!Number.isSafeInteger(amount) || amount <= 0) return "Amount clear nahi hai. Jaise: “Ramesh ko ₹200 ka udhaar do.”";
    let customer = resolved.customer;
    if (resolved.notFound) {
      const added = await postJson("/.netlify/functions/ledger", {
        action: "create_customer",
        name: customerName,
        requestId
      });
      state = { customers: added.customers, transactions: added.transactions, expenses: added.expenses || [] };
      render();
      customer = added.customer;
    }
    const type = intent === "add_credit" ? "credit" : "payment";
    const newBalance = await addTransaction(customer.id, type, amount, typeof description === "string" ? description : "", requestId, result.cost_paise);
    if (type === "credit") return `${customer.name} ke naam ${money(amount)} ka sale/udhaar save hua.${Number.isSafeInteger(result.cost_paise) ? ` Item cost ${money(result.cost_paise)}` : ""} Naya balance: ${money(newBalance)}.`;
    return newBalance < 0
      ? `${money(amount)} payment save hua. ${customer.name} ke account mein ${money(Math.abs(newBalance))} advance hai.`
      : `${money(amount)} payment save hua. ${customer.name} ka naya balance: ${money(newBalance)}.`;
  };

  const speakReply = async (text, languageCode) => {
    const result = await postJson("/.netlify/functions/speak", { text: text.slice(0, 500), languageCode });
    if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl);
    currentAudioUrl = URL.createObjectURL(new Blob(
      [Uint8Array.from(atob(result.audio), (character) => character.charCodeAt(0))],
      { type: "audio/wav" }
    ));
    const audio = new Audio(currentAudioUrl);
    await audio.play();
  };

  const transcribeRecording = async (blob) => {
    const status = $("#voiceStatus");
    const button = $("#micButton");
    status.textContent = "Transcribing your voice…";
    button.disabled = true;
    const extension = blob.type.includes("mp4") ? "m4a" : blob.type.includes("ogg") ? "ogg" : "webm";
    try {
      const audioBase64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener("load", () => resolve(String(reader.result).split(",")[1]));
        reader.addEventListener("error", () => reject(new Error("Could not read the audio recording.")));
        reader.readAsDataURL(blob);
      });
      const result = await postJson("/.netlify/functions/transcribe", {
          audioBase64,
          audioType: blob.type || "audio/webm",
          filename: `recording.${extension}`,
          dataset: sampleMode ? "sample" : "main"
      });
      $("#chatInput").value = result.transcript;
      pendingVoiceLanguage = result.languageCode || "hi-IN";
      status.textContent = "Voice recognized · sending automatically…";
      if (sendingMessage) {
        queuedVoiceMessage = { message: result.transcript, languageCode: pendingVoiceLanguage };
      } else {
        $("#chatForm").requestSubmit();
      }
    } catch (error) {
      status.textContent = "Tap mic or hold Space to speak";
      showToast(error instanceof Error ? error.message : "Transcription failed. Please try again.");
    } finally {
      button.disabled = false;
    }
  };

  const stopRecording = () => {
    clearTimeout(recordingTimeout);
    recordingTimeout = null;
    if (activeRecorder && activeRecorder.state !== "inactive") activeRecorder.stop();
    $("#micButton").classList.remove("recording");
    $("#micButton").setAttribute("aria-label", "Start voice recording");
    $("#voiceStatus").textContent = "Transcribing your voice…";
  };

  const startRecording = async (fromSpacebar = false) => {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      showToast("Mic needs a supported browser and a secure HTTPS connection.");
      return;
    }
    const button = $("#micButton");
    button.disabled = true;
    try {
      activeStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const stream = activeStream;
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]
        .find((type) => MediaRecorder.isTypeSupported(type));
      activeRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      const recorder = activeRecorder;
      const chunks = [];
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size) chunks.push(event.data);
      });
      recorder.addEventListener("stop", () => {
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        stream.getTracks().forEach((track) => track.stop());
        activeStream = null;
        if (activeRecorder === recorder) activeRecorder = null;
        if (!blob.size) {
          $("#voiceStatus").textContent = "No audio recorded · tap to try again";
          return;
        }
        void transcribeRecording(blob);
      }, { once: true });
      activeRecorder.start();
      if (fromSpacebar && !spacebarHeld) {
        stopRecording();
        return;
      }
      button.disabled = false;
      button.classList.add("recording");
      button.setAttribute("aria-label", "Stop voice recording");
      $("#voiceStatus").textContent = "Listening… tap mic to stop";
      recordingTimeout = setTimeout(stopRecording, 30000);
    } catch (error) {
      activeStream?.getTracks().forEach((track) => track.stop());
      activeStream = null;
      button.disabled = false;
      $("#voiceStatus").textContent = "Tap mic or hold Space to speak";
      showToast(error.name === "NotAllowedError" ? "Allow microphone access in your browser to use voice." : "Could not start the microphone. Please try again.");
    }
  };

  $("#micButton").addEventListener("click", () => {
    if (activeRecorder?.state === "recording") stopRecording();
    else void startRecording();
  });
  const isEditableTarget = (target) => target instanceof Element && Boolean(
    target.closest("input, textarea, select, [contenteditable='true'], dialog[open]")
  );
  window.addEventListener("keydown", (event) => {
    if (event.code !== "Space") return;
    if (spacebarHeld) {
      event.preventDefault();
      return;
    }
    if (event.repeat || event.altKey || event.ctrlKey || event.metaKey ||
        isEditableTarget(event.target) || $("#micButton").disabled) return;
    event.preventDefault();
    spacebarHeld = true;
    if (activeRecorder?.state !== "recording") void startRecording(true);
  });
  window.addEventListener("keyup", (event) => {
    if (event.code !== "Space" || !spacebarHeld) return;
    event.preventDefault();
    spacebarHeld = false;
    if (activeRecorder?.state === "recording") stopRecording();
  });

  let sendingMessage = false;
  const sendMessage = async (message, voiceLanguage, requestId = crypto.randomUUID(), appendUserMessage = true) => {
    if (sendingMessage) return;
    sendingMessage = true;
    if (appendUserMessage) appendMessage(message, "user");
    $("#chatInput").value = "";
    const send = $("#chatForm button");
    send.disabled = true;
    send.textContent = "…";
    const suggestions = $("#suggestions");
    if (suggestions) suggestions.hidden = true;
    const waiting = document.createElement("div");
    waiting.className = "chat-message assistant";
    waiting.innerHTML = '<span class="message-avatar">उ</span><div class="bubble"><p>Ek pal…</p></div>';
    $("#chatBody").append(waiting);
    $("#chatBody").scrollTop = $("#chatBody").scrollHeight;
    try {
      state = await request(ledgerPath());
      render();
      const reply = await handleAgent(message, requestId, conversationHistory.slice(-6));
      waiting.remove();
      appendMessage(reply);
      conversationHistory.push({ role: "user", content: message }, { role: "assistant", content: reply });
      conversationHistory = conversationHistory.slice(-8);
      $("#voiceStatus").textContent = "Speaking reply…";
      try {
        await speakReply(reply, voiceLanguage || "hi-IN");
      } catch (error) {
        console.error("Spoken reply could not be played:", error.message);
        showToast("Reply is ready as text; audio could not be played.");
      } finally {
        $("#voiceStatus").textContent = "Tap mic or hold Space to speak";
      }
    } catch (error) {
      waiting.remove();
      const errorMessage = error instanceof Error ? error.message : "Request complete nahi hua. Please dobara try karein.";
      showErrorWithRetry(errorMessage, () => void sendMessage(message, voiceLanguage, requestId, false));
      $("#chatInput").value = message;
    } finally {
      send.disabled = false;
      send.textContent = "↑";
      sendingMessage = false;
      if (queuedVoiceMessage) {
        $("#chatInput").value = queuedVoiceMessage.message;
        pendingVoiceLanguage = queuedVoiceMessage.languageCode;
        queuedVoiceMessage = null;
        $("#chatForm").requestSubmit();
      } else {
        $("#micButton").focus();
      }
    }
  };
  $("#chatForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("#chatInput");
    const message = input.value.trim();
    if (!message) return;
    const voiceLanguage = pendingVoiceLanguage;
    pendingVoiceLanguage = null;
    if (voiceLanguage) $("#voiceStatus").textContent = "Tap mic or hold Space to speak";
    void sendMessage(message, voiceLanguage);
  });
  $("#suggestions").addEventListener("click", (event) => {
    const button = event.target.closest(".suggestion");
    if (!button) return;
    $("#chatInput").value = button.textContent.replace("₹", "");
    $("#chatForm").requestSubmit();
  });
  $("#sampleDataButton").addEventListener("click", () => void switchDataset(true));
  $("#realLedgerButton").addEventListener("click", () => void switchDataset(false));
  $("#addExpenseTop").addEventListener("click", () => {
    $("#expenseForm").reset();
    $("#expenseError").classList.remove("visible");
    $("#expenseDialog").showModal();
    $("#expenseAmount").focus();
  });
  $("#expenseForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const amount = Number($("#expenseAmount").value);
    const error = $("#expenseError");
    const button = $("#expenseForm button[type='submit']");
    button.disabled = true;
    try {
      if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) > Number.MAX_SAFE_INTEGER) {
        throw new Error("Enter a valid expense amount greater than zero.");
      }
      const requestId = $("#expenseForm").dataset.requestId || crypto.randomUUID();
      $("#expenseForm").dataset.requestId = requestId;
      const result = await postJson("/.netlify/functions/ledger", {
        action: "create_expense",
        amountPaise: Math.round(amount * 100),
        description: $("#expenseDescription").value.trim(),
        requestId
      });
      state = { customers: result.customers, transactions: result.transactions, expenses: result.expenses || [] };
      render();
      $("#expenseDialog").close();
      showToast("Shop expense saved.");
      delete $("#expenseForm").dataset.requestId;
    } catch (errorResult) {
      error.textContent = errorResult instanceof Error ? errorResult.message : "Expense could not be saved.";
      error.classList.add("visible");
    } finally {
      button.disabled = false;
    }
  });
  $("#expenseForm").addEventListener("input", () => { delete $("#expenseForm").dataset.requestId; });
  $("#expenseForm").addEventListener("change", () => { delete $("#expenseForm").dataset.requestId; });
  $("#customerSearch").addEventListener("input", renderCustomers);
  $("#customerList").addEventListener("click", (event) => {
    const row = event.target.closest("[data-customer]");
    if (row) openHistory(row.dataset.customer);
  });
  $("#customerList").addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === " ") && event.target.matches("[data-customer]")) {
      event.preventDefault();
      openHistory(event.target.dataset.customer);
    }
  });
  $("#addCustomerTop").addEventListener("click", openCustomerDialog);
  $("#addCustomerSide").addEventListener("click", openCustomerDialog);
  $("#viewAll").addEventListener("click", () => {
    const rows = [...state.transactions, ...(state.expenses || []).map((expense) => ({ ...expense, type: "expense" }))]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    $("#historyTitle").textContent = "All transactions";
    $("#historyBalance").textContent = `${rows.length} ledger entries`;
    $("#historyList").innerHTML = rows.length ? rows.map(transactionRow).join("") : `<p class="empty-state">No entries yet.</p>`;
    $("#historyAddCredit").hidden = true;
    $("#historyDialog").showModal();
  });
  $("#historyDialog").addEventListener("close", () => { $("#historyAddCredit").hidden = false; });
  $("#historyAddCredit").addEventListener("click", (event) => {
    const customerId = event.currentTarget.dataset.customer;
    $("#historyDialog").close();
    openTransactionDialog(customerId, "credit");
  });
  document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
  $("#customerForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = $("#customerName").value.trim();
    const phone = $("#customerPhone").value.trim();
    if (state.customers.some((customer) => customer.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      $("#customerError").textContent = "Is naam ka customer pehle se hai. Duplicate banane se pehle naam check karein.";
      $("#customerError").classList.add("visible");
      return;
    }
    const submit = $("#customerForm button[type='submit']");
    submit.disabled = true;
    try {
      const requestId = $("#customerForm").dataset.requestId || crypto.randomUUID();
      $("#customerForm").dataset.requestId = requestId;
      const result = await postJson("/.netlify/functions/ledger", { action: "create_customer", name, phone, requestId });
      if (!result.customer || !Array.isArray(result.customers) || !Array.isArray(result.transactions)) {
        throw new Error("Server returned an incomplete customer record. Please reload and check the customer list.");
      }
      state = { customers: result.customers, transactions: result.transactions, expenses: result.expenses || [] };
      render();
      delete $("#customerForm").dataset.requestId;
    } catch (error) {
      $("#customerError").textContent = error instanceof Error ? error.message : "Customer could not be saved.";
      $("#customerError").classList.add("visible");
      return;
    } finally {
      submit.disabled = false;
    }
    $("#customerDialog").close();
    showToast(`${name} added.`);
  });
  $("#customerForm").addEventListener("input", () => { delete $("#customerForm").dataset.requestId; });
  $("#customerForm").addEventListener("change", () => { delete $("#customerForm").dataset.requestId; });
  $("#transactionForm").addEventListener("input", () => { delete $("#transactionForm").dataset.requestId; });
  $("#transactionForm").addEventListener("change", () => { delete $("#transactionForm").dataset.requestId; });
  $("#transactionType").addEventListener("change", () => {
    $("#costField").hidden = $("#transactionType").value !== "credit";
    $("#transactionCost").value = "";
  });
  $("#transactionForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const amount = Number($("#transactionAmount").value);
    const error = $("#transactionError");
    try {
      if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) > Number.MAX_SAFE_INTEGER) throw new Error("Enter a valid amount greater than zero.");
      const requestId = $("#transactionForm").dataset.requestId || crypto.randomUUID();
      $("#transactionForm").dataset.requestId = requestId;
      const customerId = $("#transactionCustomer").value;
      const type = $("#transactionType").value;
      const costValue = $("#transactionCost").value;
      const costPaise = type === "credit" && costValue !== "" ? Math.round(Number(costValue) * 100) : null;
      if (costValue !== "" && (!Number.isFinite(Number(costValue)) || Number(costValue) < 0 || costPaise > Number.MAX_SAFE_INTEGER)) {
        throw new Error("Enter a valid item purchase cost.");
      }
      const balance = await addTransaction(customerId, type, Math.round(amount * 100), $("#transactionDescription").value.trim(), requestId, costPaise);
      const customer = state.customers.find((item) => item.id === $("#transactionCustomer").value);
      $("#transactionDialog").close();
      showToast(balance < 0
        ? `Advance saved. ${customer.name} ke account mein ${money(Math.abs(balance))} advance hai.`
        : `Saved. ${customer.name} ka balance ${money(balance)}.`);
      delete $("#transactionForm").dataset.requestId;
    } catch (errorResult) {
      error.textContent = errorResult instanceof Error ? errorResult.message : "Transaction save nahi hua.";
      error.classList.add("visible");
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    void request(ledgerPath()).then((ledger) => {
      state = ledger;
      render();
    }).catch((error) => showToast(error.message));
  });

  void loadLedger().catch((error) => showToast(error instanceof Error ? error.message : "Could not load the local ledger."));
})();
