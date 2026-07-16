// ── Shared application logic (My Mess) ──
// This file contains the exact same functions that used to live inline in
// index.html. Nothing here was rewritten — only relocated so every page
// (Home, Add Tiffin, Record Payment, Customers, Activity History) can
// reuse the same JavaScript, IDs, and event handlers.

const API = "https://mess-tracker-production.up.railway.app";

if (localStorage.getItem("loggedIn") !== "true") {
    window.location.href = "login.html";
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
    ["allCustomersMonthFilter", "billMonthFilter", "historyMonthFilter"].forEach(id => {
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

function onHistoryMonthChange() {
    loadHistory();
}

function loadAllCustomers() {
    const container = document.getElementById("allCustomersList");
    if (!container) return;
    container.innerHTML = '<p class="empty">Loading...</p>';

    fetch(`${API}/all-customers-summary${monthYearQuery("allCustomersMonthFilter")}`)
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
            <td>₹${c.totalPaid}</td>
            <td style="color:${c.pending > 0 ? '#dc2626' : '#16a34a'};">₹${c.pending}</td>
        </tr>`).join("");

        container.innerHTML = `<div class="table-wrap"><table>
            <thead><tr>
                <th>ID</th><th>Name</th><th>Total Tiffins</th><th>Total Bill</th><th>Paid</th><th>Pending</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table></div>`;
    })
    .catch(err => {
        console.error(err);
        container.innerHTML = '<p class="empty">Failed to load customer list.</p>';
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

function toggleQR() {
    const qr = document.getElementById("qrSection");
    const btn = document.getElementById("payNowBtn");
    if (qr.style.display === "none") {
        qr.style.display = "block";
        btn.innerText = "❌ Close";
    } else {
        qr.style.display = "none";
        btn.innerText = "💳 Pay via UPI";
    }
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
        document.getElementById("bill_result").innerHTML = `
            <div class="stats-grid">
                <div class="stat-card">
                    <div class="stat-label">Tiffins</div>
                    <div class="stat-value">${data.totalTiffin}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Extra Roti</div>
                    <div class="stat-value">${data.extraRoti}</div>
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
    })
    .catch(err => {
        console.error(err);
        showAlert("bill_result", "Failed to load bill. Please try again.", "error");
    });
}

function loadHistory() {
    const id = getCustomerId("history_customer_id");
    if (!id) return;

    const q = monthYearQuery("historyMonthFilter");

    Promise.all([
        fetch(`${API}/tiffin-history/${id}${q}`).then(r => r.json()),
        fetch(`${API}/payment-history/${id}${q}`).then(r => r.json())
    ])
    .then(([tiffins, payments]) => {
        document.getElementById("tiffin_history").innerHTML = renderTable(tiffins, [
            { key: "date", label: "Date" },
            { key: "type", label: "Type" },
            { key: "quantity", label: "Qty" },
            { key: "extra_roti", label: "Roti" },
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
function loadTodaysMeals() {
    const id        = localStorage.getItem("customer_id");
    const container = document.getElementById("todaysMealsList");
    container.innerHTML = '<p class="empty">Loading...</p>';

    fetch(`${API}/menu/today/${id}`)
    .then(res => res.json())
    .then(data => {
        document.getElementById("todayDateLabel").innerText = `${data.day}, ${formatDate(data.date)}`;

        const meals = [
            { key: "lunch",  label: "Lunch" },
            { key: "dinner", label: "Dinner" }
        ];

        container.innerHTML = meals.map(m => {
            const info    = data[m.key] || {};
            const hasMenu = !!info.menu_text;
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

            return `<div class="meal-card">
                <div class="meal-card-head">
                    <h3>${m.label}</h3>
                    ${info.meal_time ? `<span class="meal-time">${formatTime12(info.meal_time)}</span>` : ""}
                </div>
                <p class="meal-menu">${info.menu_text || "—"}</p>
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
    const id = localStorage.getItem("customer_id");

    fetch(`${API}/bookings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customer_id: id, meal_type: mealType })
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
function loadBookings() {
    const container = document.getElementById("bookingsList");
    container.innerHTML = '<p class="empty">Loading...</p>';

    fetch(`${API}/admin/bookings/today`)
    .then(res => res.json())
    .then(data => {
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
                <td style="color:${statusColor}; text-transform:capitalize;">${b.status}</td>
                <td>${actionHtml}</td>
            </tr>`;
        }).join("");

        container.innerHTML = `<div class="table-wrap"><table>
            <thead><tr><th>Customer</th><th>Meal</th><th>Status</th><th>Action</th></tr></thead>
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
    })
    .catch(err => {
        console.error(err);
    });
}

function renderMenuDay(day) {
    const lunch  = menuDataCache[`${day}_Lunch`]  || {};
    const dinner = menuDataCache[`${day}_Dinner`] || {};

    document.getElementById("simple_lunch_text").value  = lunch.menu_text  || "";
    document.getElementById("simple_lunch_time").value  = lunch.meal_time  || "";
    document.getElementById("simple_dinner_text").value = dinner.menu_text || "";
    document.getElementById("simple_dinner_time").value = dinner.meal_time || "";

    document.getElementById("menu_save_result").innerHTML = "";
}

function saveMenuDay() {
    const day = document.getElementById("menuDaySelector").value;
    const btn = document.getElementById("saveMenuBtn");
    btn.disabled = true;

    const lunchPayload = {
        day_of_week: day,
        meal_type: "Lunch",
        menu_text: document.getElementById("simple_lunch_text").value,
        meal_time: document.getElementById("simple_lunch_time").value
    };
    const dinnerPayload = {
        day_of_week: day,
        meal_type: "Dinner",
        menu_text: document.getElementById("simple_dinner_text").value,
        meal_time: document.getElementById("simple_dinner_time").value
    };

    Promise.all([
        fetch(`${API}/admin/menu`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(lunchPayload) }),
        fetch(`${API}/admin/menu`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(dinnerPayload) })
    ])
    .then(() => {
        menuDataCache[`${day}_Lunch`]  = { menu_text: lunchPayload.menu_text,  meal_time: lunchPayload.meal_time };
        menuDataCache[`${day}_Dinner`] = { menu_text: dinnerPayload.menu_text, meal_time: dinnerPayload.meal_time };
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
