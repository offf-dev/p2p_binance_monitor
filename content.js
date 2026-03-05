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
    price: 'tr:not(.AdvTableList__pin-to-top) .headline5.text-primaryText',
    amount: 'tr:not(.AdvTableList__pin-to-top) td:nth-child(4) .bn-flex.flex-wrap.body3 > div:first-child'
};

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

function runMonitoringStep(targetPrice, targetAmount, statusSpan) {
    const prices = Array.from(document.querySelectorAll(selectors.price)).slice(0, 5);
    const amounts = Array.from(document.querySelectorAll(selectors.amount)).slice(0, 5);

    for (let i = 0; i < prices.length && i < amounts.length; i++) {
        const price = parseFloat(
            prices[i].textContent
                .replace(/[^\d.,]/g, '')
                .replace(/\s/g, '')
                .replace(',', '.')
        );
        const amount = parseFloat(
            amounts[i].textContent
                .replace(/[^\d.,]/g, '')
                .replace(/\s/g, '')
                .replace(',', '')
        );

        if (!isNaN(price) && !isNaN(amount) && price <= targetPrice && amount >= targetAmount) {
            statusSpan.textContent = `Найдено подходящее предложение: ₴${price}, ${amount} UAH`;
            playBeep();
            clearInterval(monitoringInterval);
            resumeTimeout = setTimeout(() => {
                if (isMonitoring) {
                    statusSpan.textContent = 'Продолжаем мониторинг...';
                    monitoringInterval = setInterval(() => runMonitoringStep(targetPrice, targetAmount, statusSpan), 1000);
                }
            }, 10000);
            break;
        }
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
        const priceElements = document.querySelectorAll(selectors.price);
        const amountElements = document.querySelectorAll(selectors.amount);
        selectorsValid = priceElements.length > 0 && amountElements.length > 0;
        statusSpan.textContent = selectorsValid ? 'Селекторы найдены ✅' : 'Селекторы не найдены ❌';
    };

    startBtn.onclick = () => {
        if (!selectorsValid) {
            statusSpan.textContent = 'Сначала проверьте селекторы!';
            return;
        }
        isMonitoring = true;
        startBtn.disabled = true;
        stopBtn.disabled = false;
        statusSpan.textContent = 'Мониторинг запущен...';

        const targetPrice = parseFloat(targetPriceInput.value.replace(',', '.'));
        const targetAmount = parseFloat(orderAmountInput.value.replace(',', '.'));

        monitoringInterval = setInterval(() => runMonitoringStep(targetPrice, targetAmount, statusSpan), 1000);
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
}
