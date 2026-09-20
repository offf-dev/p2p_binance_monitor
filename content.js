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
let ui = null;

// Способ оплаты, который должен быть выбран в форме ордера
const PREFERRED_PAYMENT = 'Monobank';

const selectors = {
    row: 'tbody.bn-web-table-tbody > tr.bn-web-table-row:not(.AdvTableList__promoted-header-row):not(.AdvTableList__pin-to-top)',
    price: 'td[aria-colindex="2"] .headline5.text-primaryText',
    amount: 'td[aria-colindex="3"] .bn-flex.flex-wrap.body3 > div:first-child',
    // id дублируется в каждой строке таблицы, поэтому ищем всегда внутри строки
    buy: 'td[aria-colindex="5"] button#C2CofferList_btn_buy, td[aria-colindex="5"] button.bn-button__buy',
    // форма ордера раскрывается отдельной <tr> сразу после строки объявления
    orderForm: 'tr.bn-web-table-expanded-row',
    orderAmount: '#C2CofferBuy_amount_input',
    orderConfirm: 'button.bn-button__buy.data-size-large',
    // данные объявления — для уведомления в Telegram
    nickname: 'td[aria-colindex="1"] a.merchantName-nickname',
    stats: 'td[aria-colindex="1"] span.body3.text-secondaryText',
    available: 'td[aria-colindex="3"] > div > div.body3:first-child',
    amountMax: 'td[aria-colindex="3"] .bn-flex.flex-wrap.body3 > div:last-child',
    payment: 'td[aria-colindex="4"] .PaymentMethodItem__text',
    // способ оплаты внутри формы ордера (он же — пункты выпадающего списка)
    paymentItem: '.PaymentMethodItem__text'
};

function stopMonitoring(message) {
    isMonitoring = false;
    clearInterval(monitoringInterval);
    clearTimeout(resumeTimeout);
    monitoringInterval = null;
    resumeTimeout = null;
    if (ui) {
        ui.startBtn.disabled = false;
        ui.stopBtn.disabled = true;
        if (message) ui.statusSpan.textContent = message;
    }
}

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

// Binance рисует числа в локали страницы: "45,35" = 45.35, "1 234,56" = 1234.56,
// в англоязычной локали то же самое выглядит как "1,234.56". Слепое выкидывание запятых
// превращало "400,00 UAH" в 40000 — отсюда и ложные пики.
function parseLocaleNumber(text) {
    const s = String(text ?? '').replace(/[^\d.,]/g, '');
    if (!s) return NaN;

    const lastSep = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'));
    if (lastSep === -1) return parseFloat(s);

    const decimals = s.length - lastSep - 1;
    // Ровно 3 цифры после последнего разделителя (или ноль) — это разделитель
    // тысяч: "1,234" / "1.234" / "40 000,". Иначе — десятичная точка.
    if (decimals === 0 || decimals === 3) {
        return parseFloat(s.replace(/[.,]/g, ''));
    }

    const intPart  = s.slice(0, lastSep).replace(/[.,]/g, '');
    const fracPart = s.slice(lastSep + 1);
    return parseFloat(`${intPart || '0'}.${fracPart}`);
}

function detectDecimalSeparator(text) {
    const s = String(text ?? '').replace(/[^\d.,]/g, '');
    const lastSep = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'));
    if (lastSep === -1) return '.';
    const decimals = s.length - lastSep - 1;
    return (decimals === 0 || decimals === 3) ? '.' : s[lastSep];
}

// В поле ордера надо писать в той же локали, в какой Binance рисует лимиты
function formatAmountForInput(amount, sampleText) {
    const str = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
    return detectDecimalSeparator(sampleText) === ',' ? str.replace('.', ',') : str;
}

// Поле контролируется React: пишем через нативный сеттер и сами шлём input/change
function setInputValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    input.focus();
    if (setter) setter.call(input, value); else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
}

function isButtonBlocked(btn) {
    return btn.disabled
        || btn.getAttribute('aria-disabled') === 'true'
        || btn.classList.contains('inactive');
}

// Форму Binance дорисовывает асинхронно, поэтому опрашиваем DOM до таймаута
function waitFor(getter, timeout = 5000, step = 100) {
    return new Promise(resolve => {
        const deadline = Date.now() + timeout;
        (function tick() {
            let value = null;
            try { value = getter(); } catch (e) { /* строку могло перерисовать */ }
            if (value) return resolve(value);
            if (Date.now() >= deadline) return resolve(null);
            setTimeout(tick, step);
        })();
    });
}

// ===== Telegram =====
// Ключи хранилища те же, что в p2p_bingx_monitor, но хранилище у каждого
// расширения своё — значения нужно ввести здесь заново.
function getStorage(keys) {
    return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

// telegram.config.json лежит в .gitignore: его может не быть — это норма.
let tgFileConfigPromise = null;
function loadTelegramFileConfig() {
    if (!tgFileConfigPromise) {
        tgFileConfigPromise = fetch(chrome.runtime.getURL('telegram.config.json'))
            .then(res => (res.ok ? res.json() : null))
            .then(cfg => ({
                token: String(cfg?.token || '').trim(),
                chatId: String(cfg?.chatId || '').trim()
            }))
            .catch(() => ({ token: '', chatId: '' }));
    }
    return tgFileConfigPromise;
}

// Файл главнее панели: что задано в telegram.config.json, то и используется.
async function tgGetConfig() {
    const file = await loadTelegramFileConfig();
    const stored = await getStorage(['telegramToken', 'telegramChatId']);
    return {
        token: file.token || (stored.telegramToken || '').trim(),
        chatId: file.chatId || (stored.telegramChatId || '').trim()
    };
}

async function tgSend(text) {
    const { token, chatId } = await tgGetConfig();
    if (!token || !chatId) return { ok: false, reason: 'не заданы token/chat_id' };
    return tgSendWith(token, chatId, text);
}

// api.telegram.org отдаёт Access-Control-Allow-Origin: *, поэтому content script
// может стучаться туда напрямую, без service worker'а.
async function tgSendWith(token, chatId, text) {
    try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
        });
        const json = await res.json();
        if (!json.ok) console.warn('[P2P Monitor] TG sendMessage not ok:', json);
        return { ok: !!json.ok, reason: json.description || '' };
    } catch (e) {
        console.error('[P2P Monitor] TG send:', e);
        return { ok: false, reason: e.message };
    }
}

// Снимок строки делаем до клика: после него React перерисовывает таблицу
function collectOfferInfo(row) {
    const clean = el => el?.textContent.trim().replace(/\s+/g, ' ') || '';
    const all = sel => [...new Set(
        Array.from(row.querySelectorAll(sel)).map(clean).filter(Boolean)
    )];
    const nickEl = row.querySelector(selectors.nickname);

    return {
        nickname: clean(nickEl) || '—',
        link: nickEl?.href || '',
        price: clean(row.querySelector(selectors.price)),
        available: clean(row.querySelector(selectors.available)),
        limitMin: clean(row.querySelector(selectors.amount)),
        limitMax: clean(row.querySelector(selectors.amountMax)),
        stats: all(selectors.stats),
        methods: all(selectors.payment)
    };
}

function buildOrderMessage({ ok, offer, criteria, filledAmount, reason, paymentUsed }) {
    const fmt = n => Number(n).toLocaleString('uk-UA');
    const range = criteria.maxAmount
        ? `${fmt(criteria.minAmount)} – ${fmt(criteria.maxAmount)} UAH`
        : `от ${fmt(criteria.minAmount)} UAH`;

    const lines = [
        ok ? '🟢 Binance P2P: ордер создан автоматически'
           : '🔴 Binance P2P: ордер НЕ создан',
        '',
        'Мои фильтры:',
        `• курс: не выше ${fmt(criteria.targetPrice)} UAH`,
        `• сумма: ${range}`,
        '',
        'Объявление:',
        `• продавец: ${offer.nickname}`,
        ...(offer.stats.length ? [`• репутация: ${offer.stats.join(' · ')}`] : []),
        `• курс: ${offer.price} UAH`,
        `• лимиты: ${offer.limitMin.replace(/\s*UAH\s*$/, '')} – ${offer.limitMax}`,
        `• доступно: ${offer.available}`,
        `• оплата: ${offer.methods.join(', ') || '—'}`,
        ...(offer.link ? [`• профиль: ${offer.link}`] : []),
        ''
    ];

    if (ok) {
        lines.push(`Сумма ордера: ${filledAmount} UAH`);
        if (paymentUsed) lines.push(`Способ оплаты: ${paymentUsed}`);
    } else {
        lines.push(
            `Причина: ${reason}`,
            filledAmount
                ? `Сумма вписана в форму: ${filledAmount} UAH, но подтверждение не прошло`
                : 'Сумма в форму не вписана',
            'Мониторинг остановлен — нужно вмешаться вручную.'
        );
    }

    lines.push(`Время: ${new Date().toLocaleString('ru-RU')}`);
    return lines.join('\n');
}

// Уведомляем только в режиме автоподтверждения: в остальных случаях
// пользователь сидит у экрана и всё видит в статусе панели.
async function notifyTelegram(payload, statusSpan) {
    if (!ui?.autoConfirmInput?.checked) return;
    const res = await tgSend(buildOrderMessage(payload));
    if (!res.ok && statusSpan) {
        statusSpan.textContent += ` (Telegram: ${res.reason || 'не отправлено'} ❌)`;
    }
}

function paymentText(el) {
    return (el?.getAttribute('aria-labelledby') || el?.textContent || '').trim().replace(/\s+/g, ' ');
}

// В форме способ оплаты выбран за нас: если это не Monobank — открываем список
// и переключаем. Не получилось — ордер не подтверждаем.
async function ensurePaymentMethod(form, wanted) {
    const wantedRe = new RegExp(wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    const firstItem = form.querySelector(selectors.paymentItem);
    if (!firstItem) return { ok: false, reason: 'блок способа оплаты в форме не найден' };

    // Список может открыться порталом внутри формы, поэтому «выбранный» способ
    // читаем строго из его собственного блока
    const host = firstItem.closest('.rounded-2l') || form;
    const selectedEl = () => (host.isConnected ? host : form).querySelector(selectors.paymentItem);

    const current = paymentText(selectedEl());
    if (wantedRe.test(current)) return { ok: true, current };

    const opener = selectedEl()?.closest('.cursor-pointer') || null;
    if (!opener) {
        return { ok: false, reason: `в объявлении только «${current}», переключить на ${wanted} нельзя` };
    }

    const before = new Set(document.querySelectorAll(selectors.paymentItem));
    opener.click();

    const option = await waitFor(() => {
        const chip = selectedEl();
        const matches = Array.from(document.querySelectorAll(selectors.paymentItem))
            .filter(el => el !== chip && wantedRe.test(paymentText(el)));
        // сначала то, что появилось после клика, иначе — любой видимый пункт
        return matches.find(el => !before.has(el))
            || matches.find(el => el.offsetParent !== null)
            || null;
    }, 3000);

    if (!option) {
        console.warn('[P2P Monitor] Способы оплаты в DOM:',
            Array.from(document.querySelectorAll(selectors.paymentItem)).map(paymentText));
        return { ok: false, reason: `${wanted} нет в списке способов оплаты (было выбрано «${current}»)` };
    }

    option.click();

    const applied = await waitFor(() => wantedRe.test(paymentText(selectedEl())) || null, 3000);
    return applied
        ? { ok: true, current: paymentText(selectedEl()) }
        : { ok: false, reason: `клик по ${wanted} не переключил способ оплаты (осталось «${paymentText(selectedEl())}»)` };
}

async function autoFillOrder({ buyBtn, rowKey, amount, sampleText, statusSpan, offer, criteria }) {
    buyBtn.click();

    const form = await waitFor(() => {
        // React мог перерисовать строку — ищем её заново по data-row-key
        const row = rowKey
            ? document.querySelector(`tr[data-row-key="${CSS.escape(rowKey)}"]`)
            : null;
        const next = row?.nextElementSibling;
        if (next?.matches(selectors.orderForm)) return next;
        return document.querySelector(selectors.orderForm);
    });

    if (!form) {
        statusSpan.textContent = 'Форма ордера не открылась ❌';
        await notifyTelegram({ ok: false, offer, criteria, reason: 'форма ордера не открылась' }, statusSpan);
        return;
    }

    // Сначала способ оплаты: его переключение перерисовывает форму и может
    // сбросить уже введённую сумму
    const payment = await ensurePaymentMethod(form, PREFERRED_PAYMENT);
    if (!payment.ok) {
        statusSpan.textContent = `Ордер не создан: ${payment.reason} ❌`;
        await notifyTelegram({ ok: false, offer, criteria, reason: payment.reason }, statusSpan);
        return;
    }

    const input = await waitFor(() => form.querySelector(selectors.orderAmount));
    if (!input) {
        statusSpan.textContent = 'Поле суммы в форме не найдено ❌';
        await notifyTelegram({ ok: false, offer, criteria, reason: 'поле суммы в форме не найдено' }, statusSpan);
        return;
    }

    const filled = formatAmountForInput(amount, sampleText);
    setInputValue(input, filled);

    if (!ui?.autoConfirmInput?.checked) {
        statusSpan.textContent = `Форма заполнена: ${filled} UAH — подтвердите вручную`;
        return;
    }

    const confirmBtn = await waitFor(() => {
        const btn = form.querySelector(selectors.orderConfirm);
        return btn && !isButtonBlocked(btn) ? btn : null;
    });

    if (!confirmBtn) {
        statusSpan.textContent = `Форма заполнена: ${filled} UAH — кнопка подтверждения неактивна ❌`;
        await notifyTelegram({
            ok: false, offer, criteria, filledAmount: filled,
            paymentUsed: payment.current,
            reason: 'кнопка подтверждения так и не стала активной'
        }, statusSpan);
        return;
    }

    confirmBtn.click();
    statusSpan.textContent = `Ордер подтверждён: ${filled} UAH`;
    await notifyTelegram({
        ok: true, offer, criteria, filledAmount: filled, paymentUsed: payment.current
    }, statusSpan);
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
        const priceEl     = rows[i].querySelector(selectors.price);
        const amountEl    = rows[i].querySelector(selectors.amount);
        const amountMaxEl = rows[i].querySelector(selectors.amountMax);
        if (!priceEl || !amountEl) continue;

        const price  = parseLocaleNumber(priceEl.textContent);
        const amount = parseLocaleNumber(amountEl.textContent);

        if (isNaN(price) || isNaN(amount)) {
            continue;
        }

        // Верхний лимит объявления; если его нет — считаем, что он равен нижнему
        const offerTop = parseLocaleNumber(amountMaxEl?.textContent);
        const offerMax = !isNaN(offerTop) && offerTop > amount ? offerTop : amount;

        // Берём по максимуму: сколько позволяет объявление, но не больше моего потолка
        const hasUserMax = !!maxAmount && !isNaN(maxAmount) && maxAmount > 0;
        const orderAmount = Math.max(amount, hasUserMax ? Math.min(maxAmount, offerMax) : offerMax);

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
            statusSpan.textContent =
                `Найдено: ₴${price.toFixed(2)}, ордер на ${orderAmount} UAH (лимиты ${amount} – ${offerMax})`;
            playBeep();

            if (ui?.autoFillInput?.checked) {
                const buyBtn = rows[i].querySelector(selectors.buy);
                if (buyBtn && !isButtonBlocked(buyBtn)) {
                    // дальше работаем с формой ордера — мониторить таблицу уже нечего
                    stopMonitoring(`Оформляем ордер: ₴${price.toFixed(2)}, ${orderAmount} UAH`);
                    autoFillOrder({
                        buyBtn,
                        rowKey: rows[i].getAttribute('data-row-key'),
                        amount: orderAmount,
                        sampleText: amountEl.textContent,
                        statusSpan,
                        offer: collectOfferInfo(rows[i]),
                        criteria: { targetPrice, minAmount, maxAmount }
                    });
                    return;
                }
                statusSpan.textContent += ' — кнопка «Купить» не найдена ❌';
            }

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
    const autoFillInput = document.getElementById('autoFill');
    const autoConfirmInput = document.getElementById('autoConfirm');
    const tgTokenInput = document.getElementById('telegramToken');
    const tgChatIdInput = document.getElementById('telegramChatId');
    const tgTestBtn = document.getElementById('testTelegram');
    const tgStatusSpan = document.getElementById('telegramStatus');

    ui = { startBtn, stopBtn, statusSpan, autoFillInput, autoConfirmInput };

    const syncAutoConfirm = () => {
        autoConfirmInput.disabled = !autoFillInput.checked;
    };

    const STORAGE_KEY = 'p2pMonitorInputs';
    chrome.storage.local.get(STORAGE_KEY, (data) => {
        const saved = data?.[STORAGE_KEY];
        if (saved) {
            if (saved.targetPrice != null) targetPriceInput.value = saved.targetPrice;
            if (saved.minAmount != null) minAmountInput.value = saved.minAmount;
            if (saved.maxAmount != null) maxAmountInput.value = saved.maxAmount;
            if (saved.autoFill != null) autoFillInput.checked = !!saved.autoFill;
            if (saved.autoConfirm != null) autoConfirmInput.checked = !!saved.autoConfirm;
        }
        syncAutoConfirm();
    });

    const persistInputs = () => {
        chrome.storage.local.set({
            [STORAGE_KEY]: {
                targetPrice: targetPriceInput.value,
                minAmount: minAmountInput.value,
                maxAmount: maxAmountInput.value,
                autoFill: autoFillInput.checked,
                autoConfirm: autoConfirmInput.checked
            }
        });
    };
    [targetPriceInput, minAmountInput, maxAmountInput].forEach(el => {
        el.addEventListener('input', persistInputs);
    });
    autoFillInput.addEventListener('change', () => {
        syncAutoConfirm();
        persistInputs();
    });
    autoConfirmInput.addEventListener('change', persistInputs);
    syncAutoConfirm();

    // Токен и chat_id храним отдельными ключами — так же, как в p2p_bingx_monitor
    chrome.storage.local.get(['telegramToken', 'telegramChatId'], (data) => {
        if (data.telegramToken) tgTokenInput.value = data.telegramToken;
        if (data.telegramChatId) tgChatIdInput.value = data.telegramChatId;
    });
    tgTokenInput.addEventListener('input', () => {
        chrome.storage.local.set({ telegramToken: tgTokenInput.value.trim() });
    });
    tgChatIdInput.addEventListener('input', () => {
        chrome.storage.local.set({ telegramChatId: tgChatIdInput.value.trim() });
    });
    loadTelegramFileConfig().then(file => {
        const fromFile = 'Задано в telegram.config.json';
        if (file.token) {
            tgTokenInput.value = file.token;
            tgTokenInput.disabled = true;
            tgTokenInput.title = fromFile;
        }
        if (file.chatId) {
            tgChatIdInput.value = file.chatId;
            tgChatIdInput.disabled = true;
            tgChatIdInput.title = fromFile;
        }
        if (file.token || file.chatId) tgStatusSpan.textContent = 'TG: из файла';
    });

    tgTestBtn.onclick = async () => {
        const { token, chatId } = await tgGetConfig();
        if (!token || !chatId) {
            tgStatusSpan.textContent = 'Заполните token и chat_id';
            return;
        }
        tgStatusSpan.textContent = 'Отправляем...';
        const res = await tgSendWith(token, chatId, 'P2P Monitor: тестовое сообщение ✅');
        tgStatusSpan.textContent = res.ok ? 'Telegram OK ✅' : `Telegram ❌ ${res.reason}`;
    };

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

    stopBtn.onclick = () => stopMonitoring('Мониторинг остановлен.');

    if (toggleBtn && panel) {
        toggleBtn.onclick = () => {
            const collapsed = panel.classList.toggle('collapsed');
            toggleBtn.title = collapsed ? 'Развернуть' : 'Свернуть';
        };
    }

    updateNbuRate();
    setInterval(updateNbuRate, 60 * 60 * 1000);
}
