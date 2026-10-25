(() => {
  const STORAGE_KEY = "udhaaros-ledger-v1";
  const money = (paise) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(paise / 100);
  const safeDate = (date) => new Date(date).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  const seed = () => {
    const openingDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const customers = [
      { id: crypto.randomUUID(), name: "Ramesh Kumar", phone: "", createdAt: openingDate },
      { id: crypto.randomUUID(), name: "Sita Devi", phone: "", createdAt: openingDate },
      { id: crypto.randomUUID(), name: "Mohan Singh", phone: "", createdAt: openingDate },
      { id: crypto.randomUUID(), name: "Priya Sharma", phone: "", createdAt: openingDate },
      { id: crypto.randomUUID(), name: "Amit Verma", phone: "", createdAt: openingDate }
    ];
    const amounts = [30000, 15000, 0, 45000, 10000];
    const transactions = customers.flatMap((customer, index) => amounts[index] ? [{
      id: crypto.randomUUID(), customerId: customer.id, type: "credit", amountPaise: amounts[index],
      description: "Opening balance · demo", createdAt: openingDate
    }] : []);
    return { customers, transactions };
  };
  const load = () => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) {
        const initial = seed();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
        return initial;
      }
      const parsed = JSON.parse(saved);
      if (!Array.isArray(parsed.customers) || !Array.isArray(parsed.transactions)) throw new Error("Saved ledger data is invalid.");
      return parsed;
    } catch (error) {
      console.error("Could not load the local ledger.", error);
      throw error;
    }
  };
  let state;
  try {
    state = load();
  } catch {
    document.body.innerHTML = '<main class="storage-error"><h1>Ledger storage is unavailable</h1><p>UdhaarOS needs browser storage for this demo. Enable site storage in your browser and reload. No entries were saved.</p></main>';
    return;
  }
  let toastTimer;
  let pendingVoiceLanguage = null;
  let activeRecorder = null;
  let activeStream = null;
  let recordingTimeout = null;
  let currentAudioUrl = null;
  const $ = (selector) => document.querySelector(selector);
  const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const balanceFor = (customerId) => state.transactions.reduce((balance, tx) => {
    if (tx.customerId !== customerId) return balance;
    return balance + (tx.type === "credit" ? tx.amountPaise : -tx.amountPaise);
  }, 0);
  const save = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      render();
    } catch (error) {
      console.error("Could not save the local ledger.", error);
      showToast("Could not save. Check this browser's available storage.");
      throw error;
    }
  };
  $("#todayDate").textContent = new Date().toLocaleDateString("en-IN", { weekday: "long", year: "numeric", month: "long", day: "numeric" }).toLocaleUpperCase();
  const showToast = (message) => {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("visible"), 3000);
  };
  const render = () => {
    const now = Date.now();
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const recent = state.transactions.filter((tx) => new Date(tx.createdAt).getTime() >= weekAgo);
    $("#totalOutstanding").textContent = money(state.customers.reduce((sum, customer) => sum + Math.max(balanceFor(customer.id), 0), 0));
    $("#creditWeek").textContent = money(recent.filter((tx) => tx.type === "credit").reduce((sum, tx) => sum + tx.amountPaise, 0));
    $("#paymentsWeek").textContent = money(recent.filter((tx) => tx.type === "payment").reduce((sum, tx) => sum + tx.amountPaise, 0));
    $("#owingCount").textContent = state.customers.filter((customer) => balanceFor(customer.id) > 0).length;
    $("#customerCount").textContent = state.customers.length;
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
      return `<div class="customer-row" data-customer="${escapeHtml(customer.id)}" tabindex="0" role="button" aria-label="View ${escapeHtml(customer.name)} ledger">
        <span class="customer-avatar">${escapeHtml(initials)}</span>
        <span class="customer-details"><strong class="customer-name">${escapeHtml(customer.name)}</strong><small>${escapeHtml(customer.phone || "Customer")}</small></span>
        <span class="customer-balance ${balance <= 0 ? "zero" : ""}">${money(balance)}</span>
      </div>`;
    }).join("") : `<p class="empty-state">No customers found.</p>`;
  };
  const transactionRow = (tx) => {
    const customer = state.customers.find((item) => item.id === tx.customerId);
    const isCredit = tx.type === "credit";
    return `<div class="activity-row">
      <span class="activity-icon ${isCredit ? "credit" : "payment"}">${isCredit ? "↗" : "↓"}</span>
      <span class="activity-copy"><strong>${escapeHtml(customer?.name || "Unknown customer")}</strong><small>${isCredit ? "Credit" : "Payment"}${tx.description ? ` · ${escapeHtml(tx.description)}` : ""} · ${safeDate(tx.createdAt)}</small></span>
      <span class="activity-amount ${isCredit ? "credit" : "payment"}">${isCredit ? "+" : "−"}${money(tx.amountPaise)}</span>
    </div>`;
  };
  const renderActivity = () => {
    const transactions = [...state.transactions].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 6);
    $("#activityList").innerHTML = transactions.length ? transactions.map(transactionRow).join("") : `<p class="empty-state">No entries yet. Add a customer transaction to get started.</p>`;
  };
  const openCustomerDialog = () => {
    $("#customerError").classList.remove("visible");
    $("#customerForm").reset();
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
    $("#transactionError").classList.remove("visible");
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
    $("#historyBalance").textContent = `Current balance: ${money(balanceFor(customer.id))}`;
    const transactions = state.transactions.filter((tx) => tx.customerId === customer.id).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    $("#historyList").innerHTML = transactions.length ? transactions.map(transactionRow).join("") : `<p class="empty-state">No entries for this customer yet.</p>`;
    $("#historyAddCredit").dataset.customer = customer.id;
    $("#historyDialog").showModal();
  };
  const addTransaction = (customerId, type, amountPaise, description = "") => {
    const customer = state.customers.find((item) => item.id === customerId);
    if (!customer) throw new Error("Customer not found. Add the customer first.");
    if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) throw new Error("Enter an amount greater than zero.");
    const current = balanceFor(customerId);
    if (type === "payment" && amountPaise > current) throw new Error(`${customer.name} ka balance ${money(current)} hai. Payment record nahi hua.`);
    const transaction = { id: crypto.randomUUID(), customerId, type, amountPaise, description: description.slice(0, 120), createdAt: new Date().toISOString() };
    state.transactions.push(transaction);
    try {
      save();
    } catch (error) {
      state.transactions.pop();
      throw error;
    }
    return balanceFor(customerId);
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
    const matches = state.customers.filter((customer) => customer.name.toLocaleLowerCase() === needle);
    if (matches.length === 1) return { customer: matches[0] };
    if (matches.length > 1) return { error: `"${name}" naam ke kai customers hain. Customer list se sahi naam select karein.` };
    return { error: `"${name}" customer nahi mila. Pehle “Add customer” se unhe add karein.` };
  };
  const interpretLocally = async (message) => {
    const response = await fetch("/.netlify/functions/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, customerNames: state.customers.map((customer) => customer.name) })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "AI se jawab nahi mila. Thodi der baad dobara try karein.");
    return result;
  };
  const handleAgent = async (message) => {
    const result = await interpretLocally(message);
    if (result.needs_clarification || result.intent === "clarify") return result.reply || "Thoda aur detail batayein—kaunsa customer aur kitne rupaye?";
    const { intent, customer_name: customerName, amount_paise: amount, description } = result;
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
      return `Pichhle 7 din ka hisaab:\nCredit diya: ${money(credits)}\nPayment mila: ${money(payments)}\nTotal outstanding: ${money(due)}`;
    }
    if (intent === "list_customers") return state.customers.length ? `Customers (${state.customers.length}):\n${state.customers.map((customer) => `${customer.name} — ${money(balanceFor(customer.id))}`).join("\n")}` : "Abhi koi customer nahi hai.";
    const resolved = resolveCustomer(customerName);
    if (resolved.error) return resolved.error;
    const customer = resolved.customer;
    if (intent === "get_balance") return `${customer.name} ka baaki: ${money(balanceFor(customer.id))}.`;
    if (intent === "get_customer_history") {
      const records = state.transactions.filter((tx) => tx.customerId === customer.id).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5);
      return records.length ? `${customer.name} ki recent entries:\n${records.map((tx) => `${tx.type === "credit" ? "Udhaar" : "Payment"} ${money(tx.amountPaise)}${tx.description ? ` · ${tx.description}` : ""} (${safeDate(tx.createdAt)})`).join("\n")}\nCurrent balance: ${money(balanceFor(customer.id))}` : `${customer.name} ki abhi koi transaction nahi hai.`;
    }
    if (intent !== "add_credit" && intent !== "record_payment") return result.reply || "Yeh request samajh nahi aayi. Try karein: “Ramesh ka balance batao.”";
    if (!Number.isSafeInteger(amount) || amount <= 0) return "Amount clear nahi hai. Jaise: “Ramesh ko ₹200 ka udhaar do.”";
    const type = intent === "add_credit" ? "credit" : "payment";
    const newBalance = addTransaction(customer.id, type, amount, typeof description === "string" ? description : "");
    return type === "credit"
      ? `${customer.name} ke naam ${money(amount)} udhaar save hua. Naya balance: ${money(newBalance)}.`
      : `${money(amount)} payment save hua. ${customer.name} ka naya balance: ${money(newBalance)}.`;
  };

  const speakReply = async (text, languageCode) => {
    const response = await fetch("/.netlify/functions/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text.slice(0, 500), languageCode })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Could not create spoken reply.");
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
      const response = await fetch("/.netlify/functions/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audioBase64,
          audioType: blob.type || "audio/webm",
          filename: `recording.${extension}`,
          customerNames: state.customers.slice(0, 50).map((customer) => customer.name)
        })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Transcription failed. Please try again.");
      $("#chatInput").value = result.transcript;
      pendingVoiceLanguage = result.languageCode || "hi-IN";
      $("#chatInput").focus();
      status.textContent = "Text ready · review it, then tap send";
    } catch (error) {
      status.textContent = "Tap to speak · 30 sec max";
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

  const startRecording = async () => {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      showToast("Mic needs a supported browser and a secure HTTPS connection.");
      return;
    }
    const button = $("#micButton");
    button.disabled = true;
    try {
      activeStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]
        .find((type) => MediaRecorder.isTypeSupported(type));
      activeRecorder = mimeType ? new MediaRecorder(activeStream, { mimeType }) : new MediaRecorder(activeStream);
      const chunks = [];
      activeRecorder.addEventListener("dataavailable", (event) => {
        if (event.data.size) chunks.push(event.data);
      });
      activeRecorder.addEventListener("stop", () => {
        const blob = new Blob(chunks, { type: activeRecorder.mimeType || "audio/webm" });
        activeStream?.getTracks().forEach((track) => track.stop());
        activeStream = null;
        activeRecorder = null;
        if (!blob.size) {
          $("#voiceStatus").textContent = "No audio recorded · tap to try again";
          return;
        }
        void transcribeRecording(blob);
      }, { once: true });
      activeRecorder.start();
      button.disabled = false;
      button.classList.add("recording");
      button.setAttribute("aria-label", "Stop voice recording");
      $("#voiceStatus").textContent = "Listening… tap mic to stop";
      recordingTimeout = setTimeout(stopRecording, 30000);
    } catch (error) {
      activeStream?.getTracks().forEach((track) => track.stop());
      activeStream = null;
      button.disabled = false;
      $("#voiceStatus").textContent = "Tap to speak · 30 sec max";
      showToast(error.name === "NotAllowedError" ? "Allow microphone access in your browser to use voice." : "Could not start the microphone. Please try again.");
    }
  };

  $("#micButton").addEventListener("click", () => {
    if (activeRecorder?.state === "recording") stopRecording();
    else void startRecording();
  });

  $("#chatForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = $("#chatInput");
    const message = input.value.trim();
    if (!message) return;
    const voiceLanguage = pendingVoiceLanguage;
    pendingVoiceLanguage = null;
    if (voiceLanguage) $("#voiceStatus").textContent = "Tap to speak · 30 sec max";
    appendMessage(message, "user");
    input.value = "";
    const send = $("#chatForm button");
    send.disabled = true;
    send.textContent = "…";
    const waiting = document.createElement("div");
    waiting.className = "chat-message assistant";
    waiting.innerHTML = '<span class="message-avatar">उ</span><div class="bubble"><p>Ek pal…</p></div>';
    $("#chatBody").append(waiting);
    $("#chatBody").scrollTop = $("#chatBody").scrollHeight;
    try {
      const reply = await handleAgent(message);
      waiting.remove();
      appendMessage(reply);
      if (voiceLanguage) {
        try {
          await speakReply(reply, voiceLanguage);
        } catch (error) {
          console.error("Spoken reply could not be played:", error.message);
          showToast("Reply is ready as text; audio could not be played.");
        }
      }
    } catch (error) {
      waiting.remove();
      appendMessage(error instanceof Error ? error.message : "Request complete nahi hua. Please dobara try karein.");
      input.value = message;
    } finally {
      send.disabled = false;
      send.textContent = "↑";
      input.focus();
    }
  });
  $("#suggestions").addEventListener("click", (event) => {
    const button = event.target.closest(".suggestion");
    if (!button) return;
    $("#chatInput").value = button.textContent.replace("₹", "");
    $("#chatForm").requestSubmit();
  });
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
    const rows = [...state.transactions].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
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
  $("#customerForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = $("#customerName").value.trim();
    const phone = $("#customerPhone").value.trim();
    if (state.customers.some((customer) => customer.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      $("#customerError").textContent = "Is naam ka customer pehle se hai. Duplicate banane se pehle naam check karein.";
      $("#customerError").classList.add("visible");
      return;
    }
    const customer = { id: crypto.randomUUID(), name, phone, createdAt: new Date().toISOString() };
    state.customers.push(customer);
    try {
      save();
    } catch {
      state.customers.pop();
      return;
    }
    $("#customerDialog").close();
    showToast(`${name} added.`);
  });
  $("#transactionForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const amount = Number($("#transactionAmount").value);
    const error = $("#transactionError");
    try {
      if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) > Number.MAX_SAFE_INTEGER) throw new Error("Enter a valid amount greater than zero.");
      const balance = addTransaction($("#transactionCustomer").value, $("#transactionType").value, Math.round(amount * 100), $("#transactionDescription").value.trim());
      const customer = state.customers.find((item) => item.id === $("#transactionCustomer").value);
      $("#transactionDialog").close();
      showToast(`Saved. ${customer.name} ka balance ${money(balance)}.`);
    } catch (errorResult) {
      error.textContent = errorResult instanceof Error ? errorResult.message : "Transaction save nahi hua.";
      error.classList.add("visible");
    }
  });
  $("#resetDemo").addEventListener("click", () => {
    if (!confirm("Reset this browser's demo ledger to the original sample customers? This will remove entries added here.")) return;
    const previous = state;
    state = seed();
    try {
      save();
    } catch {
      state = previous;
      return;
    }
    showToast("Demo data reset.");
  });
  render();
})();
