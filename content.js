// content.js

// Если расширение только что было перезагружено — обновим страницу Binance
if (performance.getEntriesByType("navigation")[0]?.type === "reload") {
    // не трогаем
} else {
    if (document.readyState === 'complete') {
        location.reload();
    } else {
        window.addEventListener('load', () => location.reload());
    }
}

// Добавление панели
fetch(chrome.runtime.getURL('panel.html'))
    .then(response => response.text())
    .then(html => {
        const div = document.createElement('div');
        div.innerHTML = html;
        document.body.prepend(div);
        initializePanel();
    });

let monitoringInterval = null;
let isMonitoring = false;
let resumeTimeout = null;
let selectorsValid = false;

const selectors = {
    row: 'tbody.bn-web-table-tbody > tr.bn-web-table-row:not(.AdvTableList__promoted-header-row):not(.AdvTableList__pin-to-top)',
    price: 'td[aria-colindex="2"] .headline5.text-primaryText',
    amount: 'td[aria-colindex="3"] .bn-flex.flex-wrap.body3 > div:first-child'
};

function logOffer(index, price, amount, priceOk, amountOk, targetPrice, minAmount, maxAmount) {
    console.log(`[P2P Monitor] Объявление #${index + 1}:`);
    console.log(`  → Цена: ${price} (введено как ${targetPrice}) → ${priceOk ? 'OK ≤' : 'НЕ подходит >'}`);
    console.log(`  → Сумма: ${amount} (диапазон: ${minAmount} ${maxAmount ? '– ' + maxAmount : 'и больше'}) → ${amountOk ? 'OK' : 'НЕ подходит'}`);
    console.log('---');
}

async function updateNbuRate() {
    const span = document.getElementById('nbuRate');
    if (!span) return;
    try {
        const res = await fetch('https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=USD&json');
        const data = await res.json();
        const rate = data?.[0]?.rate;
        if (typeof rate === 'number') {
            span.textContent = `НБУ: ₴${rate.toFixed(2)}`;
        } else {
            span.textContent = 'НБУ: ошибка';
        }
    } catch (e) {
        span.textContent = 'НБУ: офлайн';
    }
}

function playBeep() {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(880, ctx.currentTime); // 880 Hz
    gainNode.gain.setValueAtTime(0.2, ctx.currentTime); // громкость

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.5); // полсекунды
}

function runMonitoringStep(targetPrice, minAmount, maxAmount, statusSpan) {
    const rows = Array.from(document.querySelectorAll(selectors.row)).slice(0, 5);

    let found = false;

    for (let i = 0; i < rows.length; i++) {
        const priceEl  = rows[i].querySelector(selectors.price);
        const amountEl = rows[i].querySelector(selectors.amount);
        if (!priceEl || !amountEl) continue;

        let priceStr = priceEl.textContent
            .replace(/[^\d.,]/g, '')
            .replace(/\s/g, '')
            .replace(',', '.');

        let amountStr = amountEl.textContent
            .replace(/[^\d.,]/g, '')
            .replace(/\s/g, '')
            .replace(/,/g, '');

        const price  = parseFloat(priceStr);
        const amount = parseFloat(amountStr);

        if (isNaN(price) || isNaN(amount)) {
            continue;
        }

        const priceOk = price <= targetPrice;

        let amountOk;
        if (!maxAmount || isNaN(maxAmount) || maxAmount <= 0) {
            amountOk = amount >= minAmount;
        } else {
            amountOk = amount >= minAmount && amount <= maxAmount;
        }

        // ← Вот ключевой лог
        // logOffer(i, price, amount, priceOk, amountOk, targetPrice, minAmount, maxAmount);

        if (priceOk && amountOk) {
            let rangeText = maxAmount && !isNaN(maxAmount) && maxAmount > 0
                ? `${minAmount} – ${maxAmount} UAH`
                : `от ${minAmount} UAH`;

            statusSpan.textContent = `Найдено: ₴${price.toFixed(2)}, ${amount} UAH (${rangeText})`;
            playBeep();
            clearInterval(monitoringInterval);
            resumeTimeout = setTimeout(() => {
                if (isMonitoring) {
                    statusSpan.textContent = 'Продолжаем мониторинг...';
                    monitoringInterval = setInterval(
                        () => runMonitoringStep(targetPrice, minAmount, maxAmount, statusSpan),
                        1000
                    );
                }
            }, 10000);

            found = true;
            break;
        }
    }

    if (!found) {
        // console.log('[P2P Monitor] Подходящих предложений в топ-5 нет');
    }
}

function initializePanel() {
    const startBtn = document.getElementById('startMonitoring');
    const stopBtn = document.getElementById('stopMonitoring');
    const checkBtn = document.getElementById('checkSelectors');
    const targetPriceInput = document.getElementById('targetPrice');
    const orderAmountInput = document.getElementById('orderAmount');
    const statusSpan = document.getElementById('status');
    const toggleBtn = document.getElementById('toggleCollapse');
    const panel = document.querySelector('.monitoring-panel');

    checkBtn.onclick = () => {
        const rows = document.querySelectorAll(selectors.row);
        let validCount = 0;
        rows.forEach(row => {
            if (row.querySelector(selectors.price) && row.querySelector(selectors.amount)) {
                validCount++;
            }
        });
        selectorsValid = validCount > 0;
        statusSpan.textContent = selectorsValid
            ? `Селекторы найдены ✅ (строк: ${validCount})`
            : 'Селекторы не найдены ❌';
    };

    const minAmountInput = document.getElementById('minAmount');
    const maxAmountInput = document.getElementById('maxAmount');

    startBtn.onclick = () => {
        if (!selectorsValid) {
            statusSpan.textContent = 'Сначала проверьте селекторы!';
            return;
        }

        const targetPriceRaw = targetPriceInput.value.replace(',', '.');
        const minRaw  = minAmountInput.value.replace(',', '');
        const maxRaw  = maxAmountInput.value.replace(',', '');

        const targetPrice = parseFloat(targetPriceRaw);
        const minAmount   = parseFloat(minRaw);
        const maxAmount   = maxRaw.trim() !== '' ? parseFloat(maxRaw) : null;

        if (isNaN(targetPrice) || isNaN(minAmount) || minAmount <= 0) {
            statusSpan.textContent = 'Некорректные значения цены или минимальной суммы';
            return;
        }

        isMonitoring = true;
        startBtn.disabled = true;
        stopBtn.disabled = false;
        statusSpan.textContent = 'Мониторинг запущен...';

        monitoringInterval = setInterval(
            () => runMonitoringStep(targetPrice, minAmount, maxAmount, statusSpan),
            1000
        );
    };

    stopBtn.onclick = () => {
        isMonitoring = false;
        clearInterval(monitoringInterval);
        clearTimeout(resumeTimeout);
        startBtn.disabled = false;
        stopBtn.disabled = true;
        statusSpan.textContent = 'Мониторинг остановлен.';
    };

    if (toggleBtn && panel) {
        toggleBtn.onclick = () => {
            const collapsed = panel.classList.toggle('collapsed');
            toggleBtn.title = collapsed ? 'Развернуть' : 'Свернуть';
        };
    }

    updateNbuRate();
    setInterval(updateNbuRate, 60 * 60 * 1000);
}
