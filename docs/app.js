// ── Shared application logic (My Mess) ──
// This file contains the exact same functions that used to live inline in
// index.html. Nothing here was rewritten — only relocated so every page
// (Home, Add Tiffin, Record Payment, Customers, Activity History) can
// reuse the same JavaScript, IDs, and event handlers.

const API = "https://my-mess-q25u.onrender.com";

// Remembers the most recently loaded bill so payNow() knows the pending
// amount without needing another round-trip to the server.
let lastBillData = null;

if (localStorage.getItem("loggedIn") !== "true") {
    window.location.href = "login.html";
}

function stepValue(id, delta) {
    const el = document.getElementById(id);
    if (!el) return;
    const min = parseInt(el.min, 10) || 0;
    const current = parseInt(el.value, 10) || 0;
    const next = Math.max(min, current + delta);
    el.value = next;
}

function getRole() {
    return (localStorage.getItem("role") || "customer").toLowerCase().trim();
}

function isAdmin() {
    return getRole() === "admin";
}

// ── Month-Year filter helpers (shared across sections) ──
function getCurrentMonthValue() {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    return `${yyyy}-${mm}`;
}

function initMonthFilters() {
    const current = getCurrentMonthValue();
    ["allCustomersMonthFilter", "billMonthFilter"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = current;
    });
}

function monthYearQuery(inputId) {
    const el = document.getElementById(inputId);
    if (!el || !el.value) return "";
    const [year, month] = el.value.split("-");
    return `?month=${Number(month)}&year=${Number(year)}`;
}

function onAllCustomersMonthChange() {
    loadAllCustomers();
}

function onBillMonthChange() {
    getBill();
}

function loadAllCustomers() {
    const container = document.getElementById("allCustomersList");
    if (!container) return;
    container.innerHTML = '<p class="empty">Loading...</p>';

    fetch(`${API}/api/monthly-summary${monthYearQuery("allCustomersMonthFilter")}`)
    .then(res => res.json())
    .then(data => {
        if (!data.length) {
            container.innerHTML = '<p class="empty">No customers found.</p>';
            return;
        }

        const rows = data.map(c => `<tr>
            <td>${c.id}</td>
            <td>${c.name}</td>
            <td>${c.totalTiffin}</td>
            <td>₹${c.totalAmount}</td>
            <td style="color:#16a34a;">₹${c.totalPaid}</td>
            <td style="color:${c.pending > 0 ? '#dc2626' : '#16a34a'};">₹${c.pending}</td>
        </tr>`).join("");

        const totals = data.reduce((acc, c) => {
            acc.totalTiffin += Number(c.totalTiffin) || 0;
            acc.totalAmount += Number(c.totalAmount) || 0;
            acc.totalPaid   += Number(c.totalPaid) || 0;
            acc.pending     += Number(c.pending) || 0;
            return acc;
        }, { totalTiffin: 0, totalAmount: 0, totalPaid: 0, pending: 0 });

        const totalRow = `<tr style="font-weight:600;border-top:2px solid rgba(255,255,255,0.15);">
            <td></td>
            <td>Total</td>
            <td>${totals.totalTiffin}</td>
            <td>₹${totals.totalAmount}</td>
            <td style="color:#16a34a;">₹${totals.totalPaid}</td>
            <td style="color:${totals.pending > 0 ? '#dc2626' : '#16a34a'};">₹${totals.pending}</td>
        </tr>`;

        container.innerHTML = `<div class="table-wrap"><table>
            <thead><tr>
                <th>ID</th><th>Name</th><th>Total Tiffins</th><th>Total Bill</th><th>Paid</th><th>Pending</th>
            </tr></thead>
            <tbody>${rows}${totalRow}</tbody>
        </table></div>`;
    })
    .catch(err => {
        console.error(err);
        container.innerHTML = '<p class="empty">Failed to load customer list.</p>';
    });
}

// ── Customers Info (admin-only customer directory page) ──
// Reuses the same /api/customers endpoint as the searchable customer
// selector (now extended server-side to also return `contact`), but keeps
// its own fetch + cache so this page's ID-ascending order isn't affected
// by the name-sorted cache used by initCustomerSelector.
let customersListData = null;

function loadCustomersList() {
    const container = document.getElementById("customersListContainer");
    if (!container) return;
    container.innerHTML = '<p class="empty">Loading...</p>';

    fetch(`${API}/api/customers`)
    .then(res => {
        if (!res.ok) throw new Error(`Request failed: ${res.status}`);
        return res.json();
    })
    .then(data => {
        customersListData = Array.isArray(data) ? data : [];
        renderCustomersListTable(customersListData);
    })
    .catch(err => {
        console.error(err);
        customersListData = null;
        container.innerHTML = '<p class="empty">Failed to load customers list.</p>';
    });
}

function filterCustomersList() {
    if (!customersListData) return; // still loading / failed — nothing to filter yet

    const searchEl = document.getElementById("customersListSearch");
    const query = (searchEl && searchEl.value || "").trim().toLowerCase();

    if (!query) {
        renderCustomersListTable(customersListData);
        return;
    }

    const filtered = customersListData.filter(c =>
        String(c.id).toLowerCase().includes(query) ||
        String(c.name || "").toLowerCase().includes(query) ||
        String(c.contact || "").toLowerCase().includes(query)
    );
    renderCustomersListTable(filtered);
}

function renderCustomersListTable(list) {
    const container = document.getElementById("customersListContainer");
    const countBadge = document.getElementById("customersListCount");
    if (!container) return;

    // The badge always reflects the total registered customer count, not
    // the number of rows currently visible after a search filter.
    if (countBadge) {
        const total = customersListData ? customersListData.length : list.length;
        countBadge.innerText = `Total Customers = ${total}`;
    }

    if (!list.length) {
        container.innerHTML = '<p class="empty">No customers found.</p>';
        return;
    }

    const rows = list.map(c => `<tr>
        <td>${c.id}</td>
        <td>${c.name}</td>
        <td>${c.contact ?? "—"}</td>
    </tr>`).join("");

    container.innerHTML = `<div class="table-wrap"><table>
        <thead><tr>
            <th>Customer ID</th><th>Customer Name</th><th>Phone Number</th>
        </tr></thead>
        <tbody>${rows}</tbody>
    </table></div>`;
}

// ── Reusable searchable customer selector (combobox) ──
// Used on Add Tiffin, Record Payment, Bill Summary and Activity History
// wherever an admin used to type a raw customer ID. Markup convention for
// a selector with base id "X":
//   <input id="X_search">   — visible text search box
//   <input id="X" type="hidden"> — keeps storing the numeric customer_id,
//                                   same id everything else already reads
//   <ul id="X_list">        — dropdown of matches
// Fetches /customers once per page load, sorts alphabetically, and caches
// it in memory so every selector instance on the page shares one request.
let customerDirectoryCache   = null;
let customerDirectoryPromise = null;

function sortCustomersByName(customers) {
    return customers.slice().sort((a, b) =>
        a.name.trim().localeCompare(b.name.trim(), undefined, { sensitivity: "base" })
    );
}

function loadCustomerDirectory() {
    if (customerDirectoryCache) return Promise.resolve(customerDirectoryCache);
    if (customerDirectoryPromise) return customerDirectoryPromise;

    customerDirectoryPromise = fetch(`${API}/api/customers`)
        .then(res => {
            if (!res.ok) throw new Error(`Request failed: ${res.status}`);
            return res.json();
        })
        .then(data => {
            const list = Array.isArray(data) ? data : [];
            customerDirectoryCache = sortCustomersByName(list);
            return customerDirectoryCache;
        })
        .catch(err => {
            console.error(err);
            customerDirectoryPromise = null; // let a later call (e.g. a retry) try again
            throw err;
        });

    return customerDirectoryPromise;
}

function initCustomerSelector(baseId) {
    const searchEl = document.getElementById(`${baseId}_search`);
    const hiddenEl = document.getElementById(baseId);
    const listEl   = document.getElementById(`${baseId}_list`);
    if (!searchEl || !hiddenEl || !listEl) return;

    const readyPlaceholder = searchEl.getAttribute("placeholder") || "Search customer by name or ID...";
    let matches  = [];
    let activeIndex = -1;
    let ready = false; // becomes true once the directory has loaded successfully

    function label(customer) {
        return `${customer.name} (#${customer.id})`;
    }

    function closeList() {
        listEl.hidden = true;
        searchEl.setAttribute("aria-expanded", "false");
        searchEl.removeAttribute("aria-activedescendant");
        activeIndex = -1;
    }

    function highlight(index) {
        const options = listEl.querySelectorAll(".customer-selector-option");
        options.forEach(opt => opt.classList.remove("active"));
        if (index >= 0 && options[index]) {
            options[index].classList.add("active");
            options[index].scrollIntoView({ block: "nearest" });
            searchEl.setAttribute("aria-activedescendant", options[index].id);
        } else {
            searchEl.removeAttribute("aria-activedescendant");
        }
        activeIndex = index;
    }

    function selectCustomer(customer) {
        hiddenEl.value = customer.id;
        searchEl.value = label(customer);
        closeList();
    }

    function renderList() {
        if (!ready) return; // no searching before the directory has loaded

        // While a selection is showing (e.g. "Pranav Chikane (#5)"), treat
        // opening the dropdown as "browse everyone" rather than filtering
        // by that display text. Real filtering resumes once hiddenEl.value
        // is cleared by an actual edit (see the "input" listener below).
        const query = hiddenEl.value ? "" : searchEl.value.trim().toLowerCase();

        loadCustomerDirectory().then(customers => {
            const filtered = !query ? customers : customers.filter(c =>
                c.name.toLowerCase().includes(query) || String(c.id).includes(query)
            );
            matches = sortCustomersByName(filtered);

            if (!matches.length) {
                listEl.innerHTML = '<li class="customer-selector-empty">No customer found</li>';
                listEl.hidden = false;
                searchEl.setAttribute("aria-expanded", "true");
                return;
            }

            listEl.innerHTML = matches.map((c, i) => `
                <li class="customer-selector-option" id="${baseId}_opt_${i}" role="option" data-index="${i}">
                    <span>${c.name}</span><span class="customer-selector-id">#${c.id}</span>
                </li>`).join("");
            listEl.hidden = false;
            searchEl.setAttribute("aria-expanded", "true");

            // If the currently-selected customer is in view, pre-highlight it
            // so the dropdown visually confirms who's picked.
            if (hiddenEl.value) {
                const selectedIndex = matches.findIndex(c => String(c.id) === String(hiddenEl.value));
                if (selectedIndex >= 0) highlight(selectedIndex);
            }
        });
    }

    searchEl.addEventListener("focus", () => {
        // Selecting the existing text means the very next keystroke replaces
        // it outright — a deliberate edit, which is when we actually clear
        // the previous pick (see "input" below).
        if (hiddenEl.value) searchEl.select();
        renderList();
    });

    searchEl.addEventListener("input", () => {
        // Typing again is a manual change to the search text, so whatever
        // was previously picked no longer applies until a new option is chosen.
        if (hiddenEl.value) hiddenEl.value = "";
        renderList();
    });

    searchEl.addEventListener("keydown", (e) => {
        if (!ready) return;

        if (listEl.hidden && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            renderList();
            return;
        }

        if (e.key === "ArrowDown") {
            e.preventDefault();
            if (matches.length) highlight(Math.min(activeIndex + 1, matches.length - 1));
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            if (matches.length) highlight(Math.max(activeIndex - 1, 0));
        } else if (e.key === "Enter") {
            if (!listEl.hidden && activeIndex >= 0 && matches[activeIndex]) {
                e.preventDefault();
                selectCustomer(matches[activeIndex]);
            }
        } else if (e.key === "Escape") {
            if (!listEl.hidden) {
                e.preventDefault();
                closeList();
            }
        }
        // Tab is left untouched — the browser moves focus to the next field
        // on its own once a customer is selected.
    });

    // Prevent a dropdown click from blurring the input first (which would
    // close the list before the click handler below ever runs).
    listEl.addEventListener("mousedown", (e) => e.preventDefault());

    listEl.addEventListener("click", (e) => {
        const opt = e.target.closest(".customer-selector-option[data-index]");
        if (!opt) return;
        const customer = matches[Number(opt.dataset.index)];
        if (customer) selectCustomer(customer);
    });

    searchEl.addEventListener("blur", closeList);

    document.addEventListener("click", (e) => {
        if (!searchEl.contains(e.target) && !listEl.contains(e.target)) closeList();
    });

    // ── Loading / error / ready lifecycle ──
    searchEl.disabled = true;
    searchEl.placeholder = "Loading customers...";

    loadCustomerDirectory()
        .then(customers => {
            ready = true;
            searchEl.disabled = false;
            searchEl.placeholder = readyPlaceholder;

            // If the hidden field already holds an id (e.g. set by other
            // code before this ran), reflect the matching name + id in the
            // search box now that the directory is available.
            if (hiddenEl.value) {
                const existing = customers.find(c => String(c.id) === String(hiddenEl.value));
                if (existing) searchEl.value = label(existing);
            }
        })
        .catch(() => {
            searchEl.disabled = true;
            searchEl.placeholder = "Unable to load customers";
            listEl.innerHTML =
                '<li class="customer-selector-empty customer-selector-error">' +
                'Unable to load customers.<br>Please refresh or try again.</li>';
            listEl.hidden = false;
            searchEl.setAttribute("aria-expanded", "true");
        });
}

function getCustomerId(inputId) {
    if (isAdmin()) {
        return document.getElementById(inputId).value;
    }
    return localStorage.getItem("customer_id");
}

function showAlert(elId, message, type) {
    const el = document.getElementById(elId);
    el.className = `alert alert-${type}`;
    el.innerText = message;
}

// ── Razorpay "Pay Now" flow (customer bill payment) ──
function payNow() {
    const id = localStorage.getItem("customer_id");
    if (!id) return;

    if (!lastBillData || Number(lastBillData.pending) <= 0) {
        alert("No pending amount to pay for the selected month.");
        return;
    }

    const amount = Number(lastBillData.pending);
    const btn = document.getElementById("payNowBtn");
    const originalText = btn.innerText;
    btn.disabled = true;
    btn.innerText = "Please wait...";

    fetch(`${API}/create-razorpay-order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customer_id: id, amount: amount })
    })
    .then(res => res.json())
    .then(order => {
        btn.disabled = false;
        btn.innerText = originalText;

        if (!order.order_id) {
            alert("Unable to start payment. Please try again.");
            return;
        }

        const options = {
            key: order.key_id,
            amount: order.amount,
            currency: order.currency,
            name: "Bhandalkar Mess",
            description: "Tiffin bill payment",
            order_id: order.order_id,
            prefill: {
                name: localStorage.getItem("name") || "",
                contact: localStorage.getItem("contact") || "",
                email: localStorage.getItem("email") || ""
            },
            theme: { color: "#1fceb8" },
            handler: function () {
                getBill();
                setTimeout(getBill, 4000); // webhook ko record karne ka time dene ke liye
            },
            modal: {
                ondismiss: function () {
                    // Customer closed the checkout without paying — no action needed.
                }
            }
        };

        const rzp = new Razorpay(options);
        rzp.on("payment.failed", function () {
            alert("Payment failed. Please try again.");
        });
        rzp.open();
    })
    .catch(err => {
        console.error(err);
        btn.disabled = false;
        btn.innerText = originalText;
        alert("Unable to reach server. Please try again.");
    });
}

// ── Shared page bootstrap: role classes, role badge, account modal fields ──
function initCommon() {
    const role = getRole();
    document.documentElement.classList.remove("role-admin", "role-customer");
    document.documentElement.classList.add("role-" + role);
    document.body.classList.add("role-" + role);

    const badge = document.getElementById("roleBadge");
    if (badge) {
        badge.innerText = role;
        if (isAdmin()) badge.classList.add("admin");
    }

    initMonthFilters();

    // Highlight the active sidebar link for this page
    const current = document.body.getAttribute("data-page");
    if (current) {
        document.querySelectorAll(".sidebar-link").forEach(link => {
            link.classList.toggle("active", link.getAttribute("data-page") === current);
        });
    }

    if (!isAdmin()) {
        const idEl = document.getElementById("display_customer_id");
        if (idEl) idEl.innerText = localStorage.getItem("customer_id") || "—";
        const nameEl = document.getElementById("display_name");
        if (nameEl) nameEl.innerText = localStorage.getItem("name") || "—";
        const contactEl = document.getElementById("display_contact");
        if (contactEl) contactEl.innerText = localStorage.getItem("contact") || "—";
        const emailEl = document.getElementById("display_email");
        if (emailEl) emailEl.innerText = localStorage.getItem("email") || "—";
    }
}

let lastFocusedEl = null;

function goToAccount() {
    const modal = document.getElementById("accountModal");
    const box = document.getElementById("customerIdSection");
    if (!modal || !box) return;
    lastFocusedEl = document.activeElement;
    modal.classList.add("open");
    document.body.classList.add("modal-open");
    box.focus();
    document.addEventListener("keydown", handleAccountModalKeydown);
}

function closeAccountModal() {
    const modal = document.getElementById("accountModal");
    if (!modal) return;
    modal.classList.remove("open");
    document.body.classList.remove("modal-open");
    document.removeEventListener("keydown", handleAccountModalKeydown);
    if (lastFocusedEl) lastFocusedEl.focus();
}

function handleAccountModalKeydown(e) {
    const box = document.getElementById("customerIdSection");
    if (!box) return;

    if (e.key === "Escape") {
        closeAccountModal();
        return;
    }

    if (e.key === "Tab") {
        const focusable = box.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    }
}

// ── Hamburger sidebar drawer ──
let lastFocusedNavEl = null;

function openSidebar() {
    const sidebar = document.getElementById("sidebarDrawer");
    const overlay = document.getElementById("sidebarOverlay");
    const btn = document.getElementById("hamburgerBtn");
    if (!sidebar || !overlay) return;
    lastFocusedNavEl = document.activeElement;
    sidebar.classList.add("open");
    overlay.classList.add("open");
    document.body.classList.add("sidebar-open");
    if (btn) btn.setAttribute("aria-expanded", "true");
    sidebar.focus();
    document.addEventListener("keydown", handleSidebarKeydown);
}

function closeSidebar() {
    const sidebar = document.getElementById("sidebarDrawer");
    const overlay = document.getElementById("sidebarOverlay");
    const btn = document.getElementById("hamburgerBtn");
    if (!sidebar || !overlay) return;
    sidebar.classList.remove("open");
    overlay.classList.remove("open");
    document.body.classList.remove("sidebar-open");
    if (btn) btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("keydown", handleSidebarKeydown);
    if (lastFocusedNavEl) lastFocusedNavEl.focus();
}

function handleSidebarKeydown(e) {
    const sidebar = document.getElementById("sidebarDrawer");
    if (!sidebar) return;

    if (e.key === "Escape") {
        closeSidebar();
        return;
    }

    if (e.key === "Tab") {
        const focusable = sidebar.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    }
}

function logout() {
    localStorage.clear();
    window.location.href = "login.html";
}

function getTodayLocalDate() {
    const now = new Date();
    const offset = now.getTimezoneOffset() * 60000;
    return new Date(now.getTime() - offset).toISOString().split("T")[0];
}

function setAddTiffinDefaults() {
    const dateField = document.getElementById("date");
    const quantityField = document.getElementById("quantity");
    if (dateField) dateField.value = getTodayLocalDate();
    if (quantityField) quantityField.value = 1;
}

function addTiffin() {
    document.getElementById("addBtn").disabled = true;

    const data = {
        customer_id: document.getElementById("customer_id").value,
        date: document.getElementById("date").value,
        type: document.getElementById("type").value,
        quantity: document.getElementById("quantity").value,
        extra_roti: document.getElementById("extra_roti").value || 0,
        extra_bhakari: document.getElementById("extra_bhakari").value || 0
    };

    fetch(`${API}/add-tiffin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data)
    })
    .then(res => res.json())
    .then(data => {
        showAlert("result", data.message, data.message.includes("success") ? "success" : "error");
        if (data.message.includes("success")) {
            setAddTiffinDefaults();
            loadTodayTiffinList();
        }
    })
    .catch(err => {
        console.error(err);
        showAlert("result", "Failed to add tiffin. Please try again.", "error");
    })
    .finally(() => {
        document.getElementById("addBtn").disabled = false;
    });
}

// ── Today's Tiffins (Add Tiffin page) ──
// Shows who has already been given a tiffin for the date selected in the
// form above (defaults to today), so the admin can see it at a glance
// while adding new entries. Same table style as Activity History, but the
// Date column is swapped for the Customer name since every row here is
// already the same date.
function loadTodayTiffinList() {
    const container = document.getElementById("todayTiffinList");
    if (!container) return;

    const dateField = document.getElementById("date");
    const date = (dateField && dateField.value) || getTodayLocalDate();

    container.innerHTML = '<p class="empty">Loading...</p>';

    fetch(`${API}/tiffin-by-date/${date}`)
    .then(res => res.json())
    .then(data => {
        const countEl = document.getElementById("todayTiffinCount");
        if (countEl) countEl.textContent = `Tiffins = ${data.length}`;

        container.innerHTML = renderTable(data, [
            { key: "name", label: "Customer" },
            { key: "type", label: "Type" },
            { key: "quantity", label: "Qty" },
            { key: "extra_roti", label: "Chapati" },
            { key: "extra_bhakari", label: "Bhakari" }
        ], isAdmin() ? "deleteTodayTiffin" : null);
    })
    .catch(err => {
        console.error(err);
        container.innerHTML = '<p class="empty">Failed to load today\'s tiffins.</p>';
    });
}

function deleteTodayTiffin(id) {
    if (!confirm("Ye tiffin entry delete karni hai? Ye action undo nahi ho sakta.")) return;

    fetch(`${API}/tiffin/${id}`, { method: "DELETE" })
    .then(res => res.json())
    .then(() => {
        loadTodayTiffinList();
    })
    .catch(err => {
        console.error(err);
        alert("Delete failed. Please try again.");
    });
}

// ── Daily Tiffins History (own page) ──
// Same idea and same table shape as "Today's Tiffins" above — every
// customer's entry for one selected date — just living on its own page
// with its own date field instead of piggybacking on the Add Tiffin form.
function setDailyTiffinsDefaults() {
    const dateField = document.getElementById("dailyTiffinsDate");
    if (dateField && !dateField.value) dateField.value = getTodayLocalDate();
}

function loadDailyTiffinsHistory() {
    const container = document.getElementById("dailyTiffinsHistoryList");
    if (!container) return;

    const dateField = document.getElementById("dailyTiffinsDate");
    const date = (dateField && dateField.value) || getTodayLocalDate();

    container.innerHTML = '<p class="empty">Loading...</p>';

    fetch(`${API}/tiffin-by-date/${date}`)
    .then(res => res.json())
    .then(data => {
        const countEl = document.getElementById("dailyTiffinsCount");
        if (countEl) countEl.textContent = `Tiffins = ${data.length}`;

        container.innerHTML = renderTable(data, [
            { key: "name", label: "Customer" },
            { key: "type", label: "Type" },
            { key: "quantity", label: "Qty" },
            { key: "extra_roti", label: "Chapati" },
            { key: "extra_bhakari", label: "Bhakari" }
        ], isAdmin() ? "deleteDailyTiffin" : null);
    })
    .catch(err => {
        console.error(err);
        container.innerHTML = '<p class="empty">Failed to load tiffins history.</p>';
    });
}

function deleteDailyTiffin(id) {
    if (!confirm("Ye tiffin entry delete karni hai? Ye action undo nahi ho sakta.")) return;

    fetch(`${API}/tiffin/${id}`, { method: "DELETE" })
    .then(res => res.json())
    .then(() => {
        loadDailyTiffinsHistory();
    })
    .catch(err => {
        console.error(err);
        alert("Delete failed. Please try again.");
    });
}

function setRecordPaymentDefaults() {
    const dateField = document.getElementById("pay_date");
    // Only fill when empty, so an existing payment's date (e.g. when editing) is never overwritten.
    if (dateField && !dateField.value) dateField.value = getTodayLocalDate();
}

function addPayment() {
    document.getElementById("payBtn").disabled = true;

    const data = {
        customer_id: document.getElementById("pay_customer_id").value,
        amount_paid: document.getElementById("amount_paid").value,
        date: document.getElementById("pay_date").value
    };

    fetch(`${API}/add-payment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data)
    })
    .then(res => res.json())
    .then(data => {
        showAlert("pay_result", data.message, data.message.includes("success") ? "success" : "error");
    })
    .catch(err => {
        console.error(err);
        showAlert("pay_result", "Failed to record payment. Please try again.", "error");
    })
    .finally(() => {
        document.getElementById("payBtn").disabled = false;
    });
}

function formatDate(dateStr) {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function renderTable(rows, columns, deleteFn) {
    if (!rows.length) {
        return '<p class="empty">No records found.</p>';
    }
    const headers = columns.map(c => `<th>${c.label}</th>`).join("") + (deleteFn ? "<th></th>" : "");
    const body = rows.map(row =>
        `<tr>${columns.map(c => `<td>${c.key === 'date' ? formatDate(row[c.key]) : (row[c.key] ?? "—")}</td>`).join("")}${
            deleteFn ? `<td><button class="btn btn-danger btn-sm" onclick="${deleteFn}(${row.id})">Delete</button></td>` : ""
        }</tr>`
    ).join("");
    return `<div class="table-wrap"><table><thead><tr>${headers}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function deleteTiffin(id) {
    if (!confirm("Ye tiffin entry delete karni hai? Ye action undo nahi ho sakta.")) return;

    fetch(`${API}/tiffin/${id}`, { method: "DELETE" })
    .then(res => res.json())
    .then(data => {
        loadHistory();
    })
    .catch(err => {
        console.error(err);
        alert("Delete failed. Please try again.");
    });
}

function getBill() {
    const id = getCustomerId("bill_customer_id");
    if (!id) return;

    fetch(`${API}/final-bill/${id}${monthYearQuery("billMonthFilter")}`)
    .then(res => res.json())
    .then(data => {
        lastBillData = data;
        document.getElementById("bill_result").innerHTML = `
            <div class="stats-grid">
                <div class="stat-card">
                    <div class="stat-label">Tiffins</div>
                    <div class="stat-value">${data.totalTiffin}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Extra Chapati</div>
                    <div class="stat-value">${data.extraChapati}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Extra Bhakari</div>
                    <div class="stat-value">${data.extraBhakari}</div>
                </div>
                <div class="stat-card highlight">
                    <div class="stat-label">Total Amount</div>
                    <div class="stat-value">₹${data.totalAmount}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Paid</div>
                    <div class="stat-value">₹${data.totalPaid}</div>
                </div>
                <div class="stat-card danger">
                    <div class="stat-label">Pending</div>
                    <div class="stat-value">₹${data.pending}</div>
                </div>
            </div>`;
        loadHistory();
    })
    .catch(err => {
        console.error(err);
        showAlert("bill_result", "Failed to load bill. Please try again.", "error");
    });
}

function loadHistory() {
    const id = getCustomerId("bill_customer_id");
    if (!id) return;

    const q = monthYearQuery("billMonthFilter");

    Promise.all([
        fetch(`${API}/tiffin-history/${id}${q}`).then(r => r.json()),
        fetch(`${API}/payment-history/${id}${q}`).then(r => r.json())
    ])
    .then(([tiffins, payments]) => {
        document.getElementById("tiffin_history").innerHTML = renderTable(tiffins, [
            { key: "date", label: "Date" },
            { key: "type", label: "Type" },
            { key: "quantity", label: "Qty" },
            { key: "extra_roti", label: "Chapati" },
            { key: "extra_bhakari", label: "Bhakari" }
        ], isAdmin() ? "deleteTiffin" : null);
        document.getElementById("payment_history").innerHTML = renderTable(payments, [
            { key: "date", label: "Date" },
            { key: "amount_paid", label: "Amount (₹)" }
        ]);
    })
    .catch(err => {
        console.error(err);
        document.getElementById("tiffin_history").innerHTML =
            '<p class="empty">Failed to load history.</p>';
    });
}
// ── Activity History: tab display only (no data/logic changes) ──
function switchHistoryTab(tab) {
    const showTiffin = tab === "tiffin";

    document.getElementById("tiffin_history_panel").hidden = !showTiffin;
    document.getElementById("payment_history_panel").hidden = showTiffin;

    document.getElementById("tiffinTabBtn").classList.toggle("active", showTiffin);
    document.getElementById("paymentTabBtn").classList.toggle("active", !showTiffin);
    document.getElementById("tiffinTabBtn").setAttribute("aria-selected", showTiffin);
    document.getElementById("paymentTabBtn").setAttribute("aria-selected", !showTiffin);
}

function formatTime12(t) {
    if (!t) return "";
    const [h, m] = t.split(":").map(Number);
    const period  = h >= 12 ? "PM" : "AM";
    const hour12  = (h % 12) || 12;
    return `${String(hour12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${period}`;
}

// ── Today's Meals (Customer) ──
// Default serving time (24h "HH:MM") used when admin hasn't set one for that meal.
const DEFAULT_MEAL_TIMES = { lunch: "13:00" };

// Purely cosmetic: swaps ',' separators for a cleaner middle-dot separator
// when displaying menu text. Doesn't touch the underlying stored text.
function formatMenuText(text) {
    if (!text) return text;
    return text.split(",").map(s => s.trim()).filter(Boolean).join(" · ");
}

function loadTodaysMeals() {
    const id        = localStorage.getItem("customer_id");
    const container = document.getElementById("todaysMealsList");
    container.innerHTML = '<p class="empty">Loading...</p>';

    fetch(`${API}/menu/today/${id}`)
    .then(res => {
        if (!res.ok) throw new Error(`menu/today failed with status ${res.status}`);
        return res.json();
    })
    .then(data => {
        document.getElementById("todayDateLabel").innerText = `${data.day}, ${formatDate(data.date)}`;

        const meals = [
            { key: "lunch",  label: "Lunch" },
            { key: "dinner", label: "Dinner" }
        ];

        container.innerHTML = meals.map(m => {
            const info      = data[m.key] || {};
            const hasVeg    = !!info.veg_menu_text;
            const hasNonVeg = !!info.nonveg_menu_text;
            const hasMenu   = hasVeg || hasNonVeg;
            let actionHtml;

            if (!hasMenu) {
                actionHtml = `<p class="empty" style="padding:0.5rem 0;">Menu not announced yet</p>`;
            } else if (info.status === "approved") {
                actionHtml = `<div class="meal-status approved">✅ Booked</div>`;
            } else if (info.status === "pending") {
                actionHtml = `<div class="meal-status pending">⏳ Waiting for approval</div>`;
            } else if (info.status === "rejected") {
                actionHtml = `
                    <div class="meal-status rejected">❌ Request rejected</div>
                    <button class="btn btn-primary" onclick="bookMeal('${m.label}')">Request Again</button>`;
            } else {
                actionHtml = `<button class="btn btn-primary" onclick="bookMeal('${m.label}')">Book Tiffin</button>`;
            }

            const menuHtml = hasNonVeg
                ? `<div class="meal-food-choice" role="radiogroup" aria-label="Choose meal">
                        <p class="meal-choice-label">Choose Meal</p>
                        <label class="meal-choice-option">
                            <input type="radio" name="foodType_${m.key}" value="Veg" ${info.selected_food_type !== "Non-Veg" ? "checked" : ""}>
                            <span class="meal-choice-text"><strong>Veg</strong><br><span class="meal-menu-text">${formatMenuText(info.veg_menu_text) || "—"}</span></span>
                        </label>
                        <label class="meal-choice-option">
                            <input type="radio" name="foodType_${m.key}" value="Non-Veg" ${info.selected_food_type === "Non-Veg" ? "checked" : ""}>
                            <span class="meal-choice-text"><strong>Non-Veg</strong><br><span class="meal-menu-text">${formatMenuText(info.nonveg_menu_text)}</span></span>
                        </label>
                    </div>`
                : `<p class="meal-menu">${formatMenuText(info.veg_menu_text) || "—"}</p>`;

            const mealTime = info.meal_time || DEFAULT_MEAL_TIMES[m.key] || "";

            return `<div class="meal-card">
                <div class="meal-card-head">
                    <h3>${m.label}</h3>
                    ${mealTime ? `<span class="meal-time">${formatTime12(mealTime)}</span>` : ""}
                </div>
                ${menuHtml}
                ${actionHtml}
            </div>`;
        }).join("");
    })
    .catch(err => {
        console.error(err);
        container.innerHTML = '<p class="empty">Failed to load today\'s meals.</p>';
    });
}

function bookMeal(mealType) {
    const id  = localStorage.getItem("customer_id");
    const key = mealType.toLowerCase();

    const selectedRadio   = document.querySelector(`input[name="foodType_${key}"]:checked`);
    const selectedFoodType = selectedRadio ? selectedRadio.value : "Veg";

    fetch(`${API}/bookings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customer_id: id, meal_type: mealType, selected_food_type: selectedFoodType })
    })
    .then(res => res.json())
    .then(data => {
        loadTodaysMeals();
    })
    .catch(err => {
        console.error(err);
        alert("Booking failed. Please try again.");
    });
}

// ── Booking Requests (Admin) ──
let bookingsMealFilterValue = "Lunch";

// Before noon -> Lunch, from noon onward -> Dinner.
function getDefaultMealFilter() {
    return new Date().getHours() < 12 ? "Lunch" : "Dinner";
}

// Purely visual: switches the active segment in the Lunch / Dinner
// toggle, then reloads the bookings list filtered by the chosen meal.
function setBookingsMealFilter(value) {
    bookingsMealFilterValue = value;
    ["Lunch", "Dinner"].forEach(key => {
        const btn = document.getElementById(`bookingsMealFilter${key}`);
        if (!btn) return;
        const isActive = key === value;
        btn.classList.toggle("active", isActive);
        btn.setAttribute("aria-selected", isActive);
    });
    loadBookings();
}

function loadBookings() {
    const container = document.getElementById("bookingsList");
    container.innerHTML = '<p class="empty">Loading...</p>';

    const filterEl = document.getElementById("bookingsFoodTypeFilter");
    const foodTypeFilter = filterEl ? filterEl.value : "all";

    const mealFilter = bookingsMealFilterValue;

    fetch(`${API}/admin/bookings/today`)
    .then(res => res.json())
    .then(data => {
        if (foodTypeFilter !== "all") {
            data = data.filter(b => b.selected_food_type === foodTypeFilter);
        }
        if (mealFilter !== "all") {
            data = data.filter(b => b.meal_type === mealFilter);
        }

        const countEl = document.getElementById("bookingsTiffinCount");
        if (countEl) countEl.textContent = `Tiffins = ${data.length}`;

        if (!data.length) {
            container.innerHTML = '<p class="empty">No booking requests today.</p>';
            return;
        }

        const rows = data.map(b => {
            let actionHtml = "—";
            if (b.status === "pending") {
                actionHtml = `
                    <div class="booking-actions">
                        <button class="btn btn-success btn-sm btn-booking-action" onclick="respondBooking(${b.id}, 'approve')">Approve</button>
                        <button class="btn btn-danger btn-sm btn-booking-action" onclick="respondBooking(${b.id}, 'reject')">Reject</button>
                    </div>`;
            }
            const statusColor = b.status === 'approved' ? '#16a34a' : b.status === 'rejected' ? '#dc2626' : '#d97706';

            return `<tr>
                <td>${b.name} (#${b.customer_id})</td>
                <td>${b.meal_type}</td>
                <td>${b.selected_food_type || "—"}</td>
                <td style="color:${statusColor}; text-transform:capitalize;">${b.status}</td>
                <td>${actionHtml}</td>
            </tr>`;
        }).join("");

        container.innerHTML = `<div class="table-wrap"><table>
            <thead><tr><th>Customer</th><th>Meal</th><th>Meal Type</th><th>Status</th><th>Action</th></tr></thead>
            <tbody>${rows}</tbody>
        </table></div>`;
    })
    .catch(err => {
        console.error(err);
        container.innerHTML = '<p class="empty">Failed to load bookings.</p>';
    });
}

function respondBooking(id, action) {
    fetch(`${API}/admin/bookings/${id}/${action}`, { method: "POST" })
    .then(res => res.json())
    .then(data => {
        loadBookings();
        loadAllCustomers();
    })
    .catch(err => {
        console.error(err);
        alert("Action failed. Please try again.");
    });
}

// ── Today's Menu Manager (Admin) — simple single-day view ──
let menuDataCache = {};

// Purely visual: switches which meal's fields are shown. Both fields
// always stay in the DOM so saveMenuDay() keeps saving Lunch + Dinner together.
function setMealTab(which) {
    const isLunch = which === "lunch";
    document.getElementById("lunchFields").hidden = !isLunch;
    document.getElementById("dinnerFields").hidden = isLunch;
    document.getElementById("mealTabLunch").classList.toggle("active", isLunch);
    document.getElementById("mealTabDinner").classList.toggle("active", !isLunch);
    document.getElementById("mealTabLunch").setAttribute("aria-selected", isLunch);
    document.getElementById("mealTabDinner").setAttribute("aria-selected", !isLunch);
}

function loadMenuManager() {
    fetch(`${API}/admin/menu`)
    .then(res => res.json())
    .then(data => {
        menuDataCache = {};
        data.forEach(row => { menuDataCache[`${row.day_of_week}_${row.meal_type}`] = row; });

        const todayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });
        document.getElementById("menuDaySelector").value = todayName;
        renderMenuDay(todayName);
        setMealTab(getDefaultMealFilter().toLowerCase());
    })
    .catch(err => {
        console.error(err);
    });
}

function renderMenuDay(day) {
    const lunch  = menuDataCache[`${day}_Lunch`]  || {};
    const dinner = menuDataCache[`${day}_Dinner`] || {};

    document.getElementById("simple_lunch_text").value  = lunch.veg_menu_text  || "";
    document.getElementById("simple_lunch_time").value  = lunch.meal_time  || DEFAULT_MEAL_TIMES.lunch;
    document.getElementById("simple_lunch_nonveg_toggle").checked = !!lunch.nonveg_menu_text;
    document.getElementById("simple_lunch_nonveg_text").value = lunch.nonveg_menu_text || "";
    document.getElementById("simple_lunch_nonveg_group").hidden = !lunch.nonveg_menu_text;

    document.getElementById("simple_dinner_text").value = dinner.veg_menu_text || "";
    document.getElementById("simple_dinner_time").value = dinner.meal_time || "";
    document.getElementById("simple_dinner_nonveg_toggle").checked = !!dinner.nonveg_menu_text;
    document.getElementById("simple_dinner_nonveg_text").value = dinner.nonveg_menu_text || "";
    document.getElementById("simple_dinner_nonveg_group").hidden = !dinner.nonveg_menu_text;

    document.getElementById("menu_save_result").innerHTML = "";
}

// Shows/hides the Non-Veg textarea when the "Enable Non-Veg Menu" toggle is used.
function toggleNonVegField(which) {
    const checked = document.getElementById(`simple_${which}_nonveg_toggle`).checked;
    document.getElementById(`simple_${which}_nonveg_group`).hidden = !checked;
    if (!checked) {
        document.getElementById(`simple_${which}_nonveg_text`).value = "";
    }
}

function saveMenuDay() {
    const day = document.getElementById("menuDaySelector").value;
    const btn = document.getElementById("saveMenuBtn");
    btn.disabled = true;

    const lunchNonVegEnabled  = document.getElementById("simple_lunch_nonveg_toggle").checked;
    const dinnerNonVegEnabled = document.getElementById("simple_dinner_nonveg_toggle").checked;

    const lunchPayload = {
        day_of_week: day,
        meal_type: "Lunch",
        veg_menu_text: document.getElementById("simple_lunch_text").value,
        nonveg_menu_text: lunchNonVegEnabled ? document.getElementById("simple_lunch_nonveg_text").value : null,
        meal_time: document.getElementById("simple_lunch_time").value
    };
    const dinnerPayload = {
        day_of_week: day,
        meal_type: "Dinner",
        veg_menu_text: document.getElementById("simple_dinner_text").value,
        nonveg_menu_text: dinnerNonVegEnabled ? document.getElementById("simple_dinner_nonveg_text").value : null,
        meal_time: document.getElementById("simple_dinner_time").value
    };

    Promise.all([
        fetch(`${API}/admin/menu`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(lunchPayload) }),
        fetch(`${API}/admin/menu`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(dinnerPayload) })
    ])
    .then(() => {
        menuDataCache[`${day}_Lunch`]  = { veg_menu_text: lunchPayload.veg_menu_text,  nonveg_menu_text: lunchPayload.nonveg_menu_text,  meal_time: lunchPayload.meal_time };
        menuDataCache[`${day}_Dinner`] = { veg_menu_text: dinnerPayload.veg_menu_text, nonveg_menu_text: dinnerPayload.nonveg_menu_text, meal_time: dinnerPayload.meal_time };
        showAlert("menu_save_result", `${day}'s menu saved ✅`, "success");
    })
    .catch(err => {
        console.error(err);
        showAlert("menu_save_result", "Failed to save menu. Please try again.", "error");
    })
    .finally(() => {
        btn.disabled = false;
    });
}
