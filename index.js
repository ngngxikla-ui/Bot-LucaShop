const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Bot LucaShop is running 24/7!');
});

app.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
});

const { Client, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, ActivityType, AttachmentBuilder } = require('discord.js');

const client = new Client({ 
    intents: 32767,
    ws: {
        properties: {
            browser: "Discord Android"
        }
    }
});

const tw = require('@fortune-inc/tw-voucher');
const config = require('./config.json');
const { REST } = require("@discordjs/rest");
const { Routes } = require("discord-api-types/v9");
const fs = require('fs');
const chalk = require('chalk');
const generatePayload = require('promptpay-qr');
const QRCode = require('qrcode');

const botToken = process.env.TOKEN || config.token;

// ---------------------------------------------------------
// ระบบความปลอดภัยสำหรับการเติมเงินผ่านธนาคาร / PromptPay
// ---------------------------------------------------------
const TOPUP_FILE = './topups.json';
let dbWriteQueue = Promise.resolve();
const purchaseLocks = new Set();

function getTopups() {
    if (!fs.existsSync(TOPUP_FILE)) fs.writeFileSync(TOPUP_FILE, JSON.stringify({}, null, 4));
    try { return JSON.parse(fs.readFileSync(TOPUP_FILE, 'utf8')); } catch { return {}; }
}

function saveTopups(data) {
    const tmp = `${TOPUP_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 4));
    fs.renameSync(tmp, TOPUP_FILE);
}

function queueDbWrite(task) {
    const run = dbWriteQueue.then(() => task());
    dbWriteQueue = run.catch(() => {});
    return run;
}

function makeTopupId(userId) {
    return `BANK-${Date.now().toString(36).toUpperCase()}-${String(userId).slice(-6)}`;
}

function normalizeMoney(value) {
    const n = Number(String(value).replace(/,/g, '').trim());
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

function getBankTopupDescription() {
    return [
        `🏦 **ชื่อบัญชี:** ${config.bankAccountName || '-'}`,
        `🏦 **ธนาคาร:** ${config.bankName || '-'}`,
        `💳 **เลขบัญชี:** ${config.bankAccountNumber || '-'}`,
        `📱 **พร้อมเพย์:** ${config.promptpayNumber || '-'}`
    ].join('\n');
}

function normalizePromptPayTarget(value) {
    return String(value || '').replace(/[-\s]/g, '');
}

async function createPromptPayQrBuffer(amount) {
    const target = normalizePromptPayTarget(config.promptpayNumber);
    if (!/^\d{10}$|^\d{13}$|^\d{15}$/.test(target)) return null;
    const payload = generatePayload(target, { amount });
    return await QRCode.toBuffer(payload, {
        type: 'png',
        width: 520,
        margin: 2,
        errorCorrectionLevel: 'M'
    });
}

function getEasySlipApiKey() {
    return process.env.EASYSLIP_API_KEY || config.easyslipApiKey || '';
}

async function verifyBankSlipByUrl(slipUrl, expectedAmount, topupId) {
    const apiKey = getEasySlipApiKey();
    if (!apiKey) throw new Error('ยังไม่ได้ตั้ง EASYSLIP_API_KEY');

    const response = await fetch('https://api.easyslip.com/v2/verify/bank', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            url: slipUrl,
            remark: topupId,
            matchAccount: true,
            matchAmount: Number(expectedAmount),
            checkDuplicate: true
        })
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.success) {
        throw new Error(result?.error?.message || `EasySlip HTTP ${response.status}`);
    }

    const data = result.data || {};
    const raw = data.rawSlip || {};
    const amount = Number(data.amountInSlip ?? raw?.amount?.amount ?? 0);
    const transRef = String(raw.transRef || '').trim();

    return {
        verified: true,
        isDuplicate: data.isDuplicate === true,
        isAmountMatched: data.isAmountMatched === true || Math.abs(amount - Number(expectedAmount)) < 0.005,
        matchedAccount: data.matchedAccount || null,
        amount,
        transRef,
        rawSlip: raw
    };
}

// ---------------------------------------------------------
// ระบบจัดการฐานข้อมูล (JSON Files)
// ---------------------------------------------------------
const DB_FILE = './balances.json';
function getBalances() {
    if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({}));
    try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return {}; }
}
function saveBalances(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 4));
}

const PURCHASE_FILE = './purchases.json';
function getPurchases() {
    if (!fs.existsSync(PURCHASE_FILE)) fs.writeFileSync(PURCHASE_FILE, JSON.stringify({}));
    try { return JSON.parse(fs.readFileSync(PURCHASE_FILE, 'utf8')); } catch { return {}; }
}
function savePurchases(data) {
    fs.writeFileSync(PURCHASE_FILE, JSON.stringify(data, null, 4));
}

const PRODUCTS_FILE = './products.json';
function getProducts() {
    if (!fs.existsSync(PRODUCTS_FILE)) {
        const initial = (config && Array.isArray(config.products)) ? config.products : [];
        fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(initial, null, 4));
        return initial;
    }
    try { return JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8')); } catch { return []; }
}
function saveProducts(data) {
    fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(data, null, 4));
}

const GIVEAWAY_FILE = './giveaways.json';
function getGiveaways() {
    if (!fs.existsSync(GIVEAWAY_FILE)) fs.writeFileSync(GIVEAWAY_FILE, JSON.stringify({}));
    try { return JSON.parse(fs.readFileSync(GIVEAWAY_FILE, 'utf8')); } catch { return {}; }
}
function saveGiveaways(data) {
    fs.writeFileSync(GIVEAWAY_FILE, JSON.stringify(data, null, 4));
}

// ตรวจสอบสิทธิ์ Admin
function isAdmin(interaction) {
    const userId = interaction.user ? interaction.user.id : interaction.author.id;
    let owners = config.ownerIDs || [config.ownerID];
    if (owners && owners.includes(userId)) return true;

    if (config.adminRoleId && interaction.member && interaction.member.roles) {
        if (interaction.member.roles.cache.has(config.adminRoleId)) return true;
    }
    return false;
}

// ---------------------------------------------------------
// ลงทะเบียน Slash Commands
// ---------------------------------------------------------
let commandsMap = new Map();

commandsMap.set("setup", { name: "setup", description: "ติดตั้งหน้าต่างเมนูร้านค้าสำหรับลูกค้า (Admin Only)" });
commandsMap.set("admin_room", { name: "admin_room", description: "เปิดแผงควบคุมร้านค้าสำหรับแอดมิน (Control Room)" });
commandsMap.set("addproduct", { name: "addproduct", description: "➕ เพิ่มสินค้าใหม่เข้าสู่ร้านค้า (Admin Only)" });
commandsMap.set("deleteproduct", { name: "deleteproduct", description: "🗑️ ลบสินค้าออกจากร้านค้า (Admin Only)" });
commandsMap.set("addstock", { name: "addstock", description: "📈 เพิ่มจำนวนสต็อกสินค้า (Admin Only)" });
commandsMap.set("removestock", { name: "removestock", description: "📉 ลดจำนวนสต็อกสินค้า (Admin Only)" });
commandsMap.set("checkstock", { name: "checkstock", description: "📊 เช็คสต็อกและรายงานสินค้าทั้งหมด (Admin Only)" });

commandsMap.set("addmoney", {
    name: "addmoney",
    description: "💰 เพิ่มเงินให้บัญชีลูกค้า (Admin Only)",
    options: [
        { name: "user", description: "เลือกผู้ใช้", type: 6, required: true },
        { name: "amount", description: "จำนวนเงิน", type: 4, required: true }
    ]
});

commandsMap.set("removemoney", {
    name: "removemoney",
    description: "💸 หักเงินออกจากบัญชีลูกค้า (Admin Only)",
    options: [
        { name: "user", description: "เลือกผู้ใช้", type: 6, required: true },
        { name: "amount", description: "จำนวนเงิน", type: 4, required: true }
    ]
});

commandsMap.set("checkmoney", {
    name: "checkmoney",
    description: "💳 เช็คยอดเงินในบัญชีลูกค้า (Admin Only)",
    options: [{ name: "user", description: "เลือกผู้ใช้", type: 6, required: true }]
});

commandsMap.set("checkuser", {
    name: "checkuser",
    description: "🔍 เช็คประวัติการซื้อและข้อมูลของลูกค้า (Admin Only)",
    options: [{ name: "user", description: "เลือกผู้ใช้", type: 6, required: true }]
});

commandsMap.set("giveaway_money", {
    name: "giveaway_money",
    description: "🎉 สร้างกิจกรรมแจกเงิน/พอยต์ (Admin Only)",
    options: [
        { name: "title", description: "ชื่อกิจกรรม", type: 3, required: true },
        { name: "amount", description: "จำนวนเงินที่จะได้รับต่อคน", type: 4, required: true },
        { name: "duration", description: "ระยะเวลาจำกัด (นาที) เช่น 60", type: 4, required: true },
        { name: "max_claims", description: "จำกัดจำนวนคนที่รับได้ เช่น 10", type: 4, required: true },
        { name: "description", description: "รายละเอียดเพิ่มเติม", type: 3, required: false },
        { name: "image_url", description: "ลิงก์รูปภาพประกอบ", type: 3, required: false }
    ]
});

commandsMap.set("giveaway_program", {
    name: "giveaway_program",
    description: "🎁 สร้างกิจกรรมแจกโปรแกรม/สคริปต์/ลิงก์ (Admin Only)",
    options: [
        { name: "title", description: "ชื่อกิจกรรม", type: 3, required: true },
        { name: "link_code", description: "ลิงก์ดาวน์โหลด หรือโค้ด/สคริปต์ที่จะแจก", type: 3, required: true },
        { name: "duration", description: "ระยะเวลาจำกัด (นาที) เช่น 60", type: 4, required: true },
        { name: "max_claims", description: "จำกัดจำนวนคนที่รับได้ เช่น 10", type: 4, required: true },
        { name: "description", description: "รายละเอียดเพิ่มเติม", type: 3, required: false },
        { name: "image_url", description: "ลิงก์รูปภาพประกอบ", type: 3, required: false }
    ]
});

const rest = new REST({ version: "9" }).setToken(botToken);

client.once("ready", () => {
    (async () => {
        try {
            let commands = Array.from(commandsMap.values());
            await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
            client.user.setActivity('Roblox', { type: ActivityType.Playing });
            console.log(chalk.green(`✅ เข้าสู่ระบบสำเร็จในชื่อ : ${client.user.tag}`));
            console.log(chalk.blue(`✅ อัปเดต Slash Commands ทั้งหมดเรียบร้อยแล้ว!`));
        } catch (err) {
            console.error(err);
        }
    })();
});

// ฟังก์ชันสร้างหน้าเมนูร้านค้า
function createShopMenu() {
    const embed = new EmbedBuilder()
        .setTitle('🛒 LucaShop')
        .setDescription('• เติมเงินผ่านซองทรูมันนี่ หรือ QR/PromptPay/ธนาคาร\n• ระบบธนาคารจะสร้างรายการเฉพาะผู้ใช้และรอตรวจสอบสลิปก่อนเข้ายอด\n• เลือกซื้อสินค้าและโปรแกรมได้ทันทีผ่านปุ่มด้านล่าง\n• เลือกโปรแกรมฟรีได้ข้างล่าง')
        .setColor('Blue');
    
    if (config.imageUrl && config.imageUrl !== "") embed.setImage(config.imageUrl);

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('topup_menu').setLabel('💰 เติมเงิน (TrueMoney)').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('bank_topup_menu').setLabel('🏦 เติมผ่าน QR/ธนาคาร').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('check_balance').setLabel('💳 ดูยอดเงินในบัญชี').setStyle(ButtonStyle.Primary)
    );

    const row1b = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('buy_menu').setLabel('🛒 เลือกซื้อสินค้า').setStyle(ButtonStyle.Secondary)
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('view_prices').setLabel('❓ ดูรายการสินค้าและราคา').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('contact_admin').setLabel('🎫 ติดต่อแอดมิน').setStyle(ButtonStyle.Danger)
    );

    return { embeds: [embed], components: [row1, row1b, row2] };
}

// ฟังก์ชันสร้างหน้า Control Room
function getAdminPanel() {
    const embed = new EmbedBuilder()
        .setColor("DarkButNotBlack")
        .setTitle("⚙️ แผงควบคุมระบบแอดมิน (Control Room)")
        .setDescription("จัดการร้านค้าของคุณได้อย่างสะดวกรวดเร็ว:\n\n• **➕ เพิ่มสินค้า**: สร้างสินค้าใหม่ ตั้งราคา และยศ\n• **🗑️ ลบสินค้า**: นำสินค้าที่ไม่ได้ขายออกจากระบบ\n• **📈 เพิ่ม / 📉 ลดสต็อก**: จัดการจำนวนสินค้าเข้าออกคลัง\n• **📊 เช็คสต็อกทั้งหมด**: ตรวจสอบสต็อกและยอดขายทั้งหมด\n• **💳 จัดการเงิน / 🔍 เช็คข้อมูลผู้ใช้**: ตรวจสอบและจัดการลูกค้า")
        .setTimestamp();

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('adm_prod_add').setLabel('➕ เพิ่มสินค้า').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('adm_prod_del').setLabel('🗑️ ลบสินค้า').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('adm_stock_add').setLabel('📈 เพิ่มสต็อก').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('adm_stock_remove').setLabel('📉 ลดสต็อก').setStyle(ButtonStyle.Secondary)
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('adm_stock_check').setLabel('📊 เช็คระบบ/สต็อก').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('adm_money_manage').setLabel('💳 จัดการเงินผู้ใช้').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('adm_user_check').setLabel('🔍 เช็คผู้ใช้').setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [row1, row2] };
}

// ฟังก์ชันสร้าง Modal เพิ่มสินค้า (แก้ไขความยาว Label ให้ไม่เกิน 45 ตัวอักษร)
function buildAddProductModal() {
    const modal = new ModalBuilder().setCustomId('setup2_modal').setTitle('➕ เพิ่มสินค้าเข้าสู่ระบบ');

    const nameInput = new TextInputBuilder()
        .setCustomId('prod_name')
        .setLabel("ชื่อสินค้า")
        .setPlaceholder("เช่น ไอดี Roblox / สคริปต์ VIP")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

    const priceInput = new TextInputBuilder()
        .setCustomId('prod_price')
        .setLabel("ราคา (บาท)")
        .setPlaceholder("เช่น 50 หรือ 100")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

    const stockInput = new TextInputBuilder()
        .setCustomId('prod_stock')
        .setLabel("จำนวนสต็อก")
        .setPlaceholder("เช่น 10")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

    const roleInput = new TextInputBuilder()
        .setCustomId('prod_role')
        .setLabel("Role ID ยศที่จะได้รับ (เว้นว่างได้)")
        .setStyle(TextInputStyle.Short)
        .setRequired(false);
    
    const detailsInput = new TextInputBuilder()
        .setCustomId('prod_links')
        .setLabel("บรรทัด 1:ลิงก์ | 2:รายละเอียด | 3:รูป")
        .setPlaceholder("บรรทัด1: ลิงก์ดาวน์โหลด\nบรรทัด2: รายละเอียดสินค้า\nบรรทัด3: ลิงก์รูปตัวอย่าง")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false);

    modal.addComponents(
        new ActionRowBuilder().addComponents(nameInput),
        new ActionRowBuilder().addComponents(priceInput),
        new ActionRowBuilder().addComponents(stockInput),
        new ActionRowBuilder().addComponents(roleInput),
        new ActionRowBuilder().addComponents(detailsInput)
    );

    return modal;
}

// ---------------------------------------------------------
// ระบบ Interaction หลัก
// ---------------------------------------------------------
client.on("interactionCreate", async (interaction) => {
    try {
        // --- 1. Slash Commands ---
        if (interaction.isChatInputCommand()) {
            if (!isAdmin(interaction)) return interaction.reply({ content: "❌ สำหรับ Admin เท่านั้น", ephemeral: true });

            if (interaction.commandName === 'setup') return await interaction.reply(createShopMenu());
            if (interaction.commandName === 'admin_room') return await interaction.reply(getAdminPanel());
            if (interaction.commandName === 'addproduct') return await interaction.showModal(buildAddProductModal());

            if (interaction.commandName === 'deleteproduct') {
                const products = getProducts();
                if (products.length === 0) return interaction.reply({ content: "❌ ยังไม่มีสินค้าในระบบให้ลบ", ephemeral: true });
                const selectMenu = new StringSelectMenuBuilder().setCustomId('select_delete_product').setPlaceholder('ถังขยะ: เลือกสินค้าที่ต้องการลบถาวร');
                products.forEach(prod => { selectMenu.addOptions({ label: `🗑️ ${prod.name}`, description: `ลบสินค้านี้ออกจากระบบ | ราคา: ${prod.price} บาท`, value: prod.id }); });
                return await interaction.reply({ content: "⚠️ **โปรดเลือกสินค้าที่คุณต้องการลบทิ้งถาวร:**", components: [new ActionRowBuilder().addComponents(selectMenu)], ephemeral: true });
            }

            if (interaction.commandName === 'addstock' || interaction.commandName === 'removestock') {
                const products = getProducts();
                if (products.length === 0) return interaction.reply({ content: "❌ ยังไม่มีสินค้าในระบบ", ephemeral: true });
                const actionType = interaction.commandName === 'addstock' ? "add" : "remove";
                const selectMenu = new StringSelectMenuBuilder().setCustomId(`stock_action_${actionType}`).setPlaceholder('เลือกสินค้าที่ต้องการปรับสต็อก');
                products.forEach(prod => {
                    selectMenu.addOptions({ label: prod.name, description: `สต็อกปัจจุบัน: ${prod.stock || 0} ชิ้น`, value: prod.id });
                });
                return await interaction.reply({ content: `📦 **โปรดเลือกสินค้าที่ต้องการ${actionType === 'add' ? 'เพิ่ม' : 'ลด'}สต็อก:**`, components: [new ActionRowBuilder().addComponents(selectMenu)], ephemeral: true });
            }

            if (interaction.commandName === 'checkstock') {
                const products = getProducts();
                const purchases = getPurchases();
                let desc = "📋 **รายงานสถานะสินค้าทั้งหมด:**\n\n";

                if (products.length === 0) {
                    desc += "ยังไม่มีสินค้าในระบบ";
                } else {
                    products.forEach((p, index) => {
                        let stockCount = p.stock || 0;
                        let totalSold = 0;
                        Object.values(purchases).forEach(userPurchases => {
                            if (Array.isArray(userPurchases)) {
                                userPurchases.forEach(up => { if (up.productName === p.name) totalSold++; });
                            }
                        });
                        let stockStatus = stockCount > 0 ? `📦 คงเหลือ: **${stockCount} ชิ้น**` : "❌ **สินค้าหมดสต็อก**";
                        desc += `**${index + 1}. ${p.name}**\n${stockStatus} | 🛒 ขายไปแล้ว: **${totalSold} ชิ้น** | 💵 ${p.price} บาท\n-----------------------------------\n`;
                    });
                }
                return await interaction.reply({ embeds: [new EmbedBuilder().setColor("Gold").setTitle("📊 ตรวจสอบสต็อกและสินค้า").setDescription(desc)], ephemeral: true });
            }

            if (interaction.commandName === 'addmoney' || interaction.commandName === 'removemoney') {
                const targetUser = interaction.options.getUser('user');
                const amount = interaction.options.getInteger('amount');
                if (amount <= 0) return interaction.reply({ content: "❌ กรุณากรอกจำนวนเงินให้มากกว่า 0", ephemeral: true });

                const balances = getBalances();
                if (!balances[targetUser.id]) balances[targetUser.id] = 0;

                if (interaction.commandName === 'addmoney') balances[targetUser.id] += amount;
                else balances[targetUser.id] = Math.max(0, balances[targetUser.id] - amount);
                saveBalances(balances);

                return await interaction.reply({ content: `✅ **${interaction.commandName === 'addmoney' ? 'เพิ่ม' : 'หัก'}เงิน** จำนวน **${amount} บาท** ให้กับ <@${targetUser.id}> สำเร็จ\n💰 ยอดคงเหลือ: **${balances[targetUser.id]} บาท**`, ephemeral: true });
            }

            if (interaction.commandName === 'checkmoney') {
                const targetUser = interaction.options.getUser('user');
                const balances = getBalances();
                return await interaction.reply({ content: `💳 ยอดเงินของ <@${targetUser.id}> คือ **${balances[targetUser.id] || 0} บาท**`, ephemeral: true });
            }

            if (interaction.commandName === 'checkuser') {
                const targetUser = interaction.options.getUser('user');
                const balances = getBalances();
                const purchases = getPurchases();

                const userBalance = balances[targetUser.id] || 0;
                const userPurchases = purchases[targetUser.id] || [];
                let purchaseHistory = userPurchases.length > 0 ? userPurchases.map(p => `• **${p.productName}** (${p.price} บาท)`).join('\n') : "ยังไม่มีประวัติการซื้อ";

                const embed = new EmbedBuilder().setColor("Purple").setTitle(`🔍 ข้อมูลผู้ใช้: ${targetUser.tag}`).addFields(
                    { name: "💳 ยอดเงินคงเหลือ", value: `${userBalance} บาท`, inline: true },
                    { name: "🛒 ประวัติการซื้อสินค้า", value: purchaseHistory, inline: false }
                );
                return await interaction.reply({ embeds: [embed], ephemeral: true });
            }

            // กิจกรรมแจกเงิน / แจกโปรแกรม
            if (interaction.commandName === 'giveaway_money' || interaction.commandName === 'giveaway_program') {
                const isMoney = interaction.commandName === 'giveaway_money';
                const title = interaction.options.getString('title');
                const durationMinutes = interaction.options.getInteger('duration');
                const maxClaims = interaction.options.getInteger('max_claims');
                const description = interaction.options.getString('description') || "กดปุ่มด้านล่างเพื่อรับของขวัญฟรีได้เลย!";
                const imageUrl = interaction.options.getString('image_url');

                const rewardValue = isMoney ? interaction.options.getInteger('amount') : interaction.options.getString('link_code');

                if (durationMinutes <= 0 || maxClaims <= 0) {
                    return interaction.reply({ content: "❌ ระยะเวลาและจำนวนสิทธิ์ต้องมากกว่า 0 ครับ", ephemeral: true });
                }

                const giveawayId = `gw_${Date.now()}`;
                const endsAt = Date.now() + (durationMinutes * 60 * 1000);
                const endsAtUnix = Math.floor(endsAt / 1000);

                const embed = new EmbedBuilder()
                    .setTitle(isMoney ? `🎉 [แจกเงินฟรี] ${title}` : `🎁 [แจกโปรแกรมฟรี] ${title}`)
                    .setDescription(`${description}\n\n🎁 **รางวัลที่ได้รับ:** ${isMoney ? `**${rewardValue} บาท**` : 'โปรแกรม / สคริปต์ฟรี'}\n👥 **จำกัดคนรับ:** **0/${maxClaims} คน**\n⏰ **หมดเวลาใน:** <t:${endsAtUnix}:R> (<t:${endsAtUnix}:f>)`)
                    .setColor(isMoney ? "Gold" : "LuminousVividPink")
                    .setTimestamp();

                if (imageUrl && imageUrl.trim() !== "") embed.setImage(imageUrl);

                const claimBtn = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`claim_gw_${giveawayId}`)
                        .setLabel('🎁 กดรับรางวัล')
                        .setStyle(ButtonStyle.Success)
                );

                const msg = await interaction.reply({ embeds: [embed], components: [claimBtn], fetchReply: true });

                const giveaways = getGiveaways();
                giveaways[giveawayId] = {
                    id: giveawayId,
                    type: isMoney ? 'money' : 'program',
                    title: title,
                    reward: rewardValue,
                    maxClaims: maxClaims,
                    claimedUsers: [],
                    endsAt: endsAt,
                    messageId: msg.id,
                    channelId: msg.channelId,
                    ended: false,
                    imageUrl: imageUrl || "",
                    description: description
                };
                saveGiveaways(giveaways);
                return;
            }
        }

        // --- 2. Buttons ---
        if (interaction.isButton()) {
            
            // ปุ่มรับของรางวัล Giveaway
            if (interaction.customId.startsWith('claim_gw_')) {
                const giveawayId = interaction.customId.replace('claim_gw_', '');
                const giveaways = getGiveaways();
                const gw = giveaways[giveawayId];

                if (!gw) return interaction.reply({ content: "❌ กิจกรรมนี้สิ้นสุดหรือถูกลบไปแล้ว", ephemeral: true });

                if (Date.now() > gw.endsAt || gw.ended) {
                    gw.ended = true;
                    saveGiveaways(giveaways);
                    return interaction.reply({ content: "❌ กิจกรรมนี้หมดเวลาการรับแล้วครับ!", ephemeral: true });
                }

                if (gw.claimedUsers.includes(interaction.user.id)) {
                    return interaction.reply({ content: "❌ คุณเคยรับของขวัญชิ้นนี้ไปแล้วครับ!", ephemeral: true });
                }

                if (gw.claimedUsers.length >= gw.maxClaims) {
                    return interaction.reply({ content: "❌ สิทธิ์ถูกรับไปครบเต็มจำนวนแล้วครับ!", ephemeral: true });
                }

                gw.claimedUsers.push(interaction.user.id);

                let replyMsg = "";
                if (gw.type === 'money') {
                    const balances = getBalances();
                    if (!balances[interaction.user.id]) balances[interaction.user.id] = 0;
                    balances[interaction.user.id] += parseInt(gw.reward);
                    saveBalances(balances);
                    replyMsg = `✅ **ยินดีด้วยครับ!** คุณได้รับเงินจำนวน **${gw.reward} บาท** เข้าสู่ระบบเรียบร้อยแล้ว! 💰\n💳 ยอดเงินคงเหลือปัจจุบัน: **${balances[interaction.user.id]} บาท**`;
                } else {
                    replyMsg = `✅ **ยินดีด้วยครับ!** คุณได้รับโปรแกรม/สคริปต์เรียบร้อยแล้ว!\n\n🔗 **ลิงก์ดาวน์โหลด / รายละเอียด:**\n${gw.reward}`;
                }

                const isFull = gw.claimedUsers.length >= gw.maxClaims;
                if (isFull) gw.ended = true;

                saveGiveaways(giveaways);

                try {
                    const endsAtUnix = Math.floor(gw.endsAt / 1000);
                    const updatedEmbed = new EmbedBuilder()
                        .setTitle(gw.type === 'money' ? `🎉 [แจกเงินฟรี] ${gw.title}` : `🎁 [แจกโปรแกรมฟรี] ${gw.title}`)
                        .setDescription(`${gw.description}\n\n🎁 **รางวัลที่ได้รับ:** ${gw.type === 'money' ? `**${gw.reward} บาท**` : 'โปรแกรม / สคริปต์ฟรี'}\n👥 **จำกัดคนรับ:** **${gw.claimedUsers.length}/${gw.maxClaims} คน** ${isFull ? '🔴 **(คนรับเต็มแล้ว)**' : ''}\n⏰ **หมดเวลาใน:** <t:${endsAtUnix}:R>`)
                        .setColor(isFull ? "Grey" : (gw.type === 'money' ? "Gold" : "LuminousVividPink"))
                        .setTimestamp();

                    if (gw.imageUrl && gw.imageUrl.trim() !== "") updatedEmbed.setImage(gw.imageUrl);

                    const updatedBtn = new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId(`claim_gw_${gw.id}`)
                            .setLabel(isFull ? '🔒 คนรับเต็มแล้ว' : '🎁 กดรับรางวัล')
                            .setStyle(isFull ? ButtonStyle.Secondary : ButtonStyle.Success)
                            .setDisabled(isFull)
                    );

                    await interaction.message.edit({ embeds: [updatedEmbed], components: [updatedBtn] });
                } catch (err) {
                    console.log("ไม่สามารถอัปเดต Embed ข้อความได้:", err);
                }

                return interaction.reply({ content: replyMsg, ephemeral: true });
            }

            if (interaction.customId === "topup_menu") {
                const modal = new ModalBuilder().setCustomId('topup_modal').setTitle('เติมเงินด้วยซองอั่งเปา TrueMoney');
                const codeInput = new TextInputBuilder().setCustomId('codeInput').setLabel("ใส่ลิ้งค์ซองอังเปาที่นี่").setPlaceholder('https://gift.truemoney.com/campaign/?v=...').setStyle(TextInputStyle.Short).setRequired(true);
                modal.addComponents(new ActionRowBuilder().addComponents(codeInput));
                return await interaction.showModal(modal);
            }

            if (interaction.customId === "bank_topup_menu") {
                const topups = getTopups();
                const existing = Object.values(topups).find(t =>
                    t.userId === interaction.user.id && ['awaiting_slip', 'pending'].includes(t.status)
                );
                if (existing) {
                    return interaction.reply({
                        embeds: [new EmbedBuilder()
                            .setColor("Orange")
                            .setTitle("⏳ มีรายการเติมเงินที่กำลังตรวจสอบ")
                            .setDescription(`คุณมีรายการค้างอยู่แล้ว\n🧾 รายการ: **${existing.id}**\n💰 จำนวน: **${existing.amount} บาท**\n\nกรุณารอรายการเดิมเสร็จก่อน เพื่อป้องกันการเติมเงินซ้อน/เข้าผิดบัญชี.`)],
                        ephemeral: true
                    });
                }

                const modal = new ModalBuilder()
                    .setCustomId('bank_topup_modal')
                    .setTitle('🏦 เติมเงินผ่าน QR / PromptPay / ธนาคาร');

                const amountInput = new TextInputBuilder()
                    .setCustomId('bank_amount')
                    .setLabel("จำนวนเงินที่โอน (บาท)")
                    .setPlaceholder("เช่น 100")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);

                const refInput = new TextInputBuilder()
                    .setCustomId('bank_ref')
                    .setLabel("เลขอ้างอิงจากสลิป (ถ้ามี)")
                    .setPlaceholder("เช่น 123456789")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false);

                modal.addComponents(
                    new ActionRowBuilder().addComponents(amountInput),
                    new ActionRowBuilder().addComponents(refInput)
                );
                return await interaction.showModal(modal);
            }

            if (interaction.customId === "check_balance") {
                const balances = getBalances();
                return await interaction.reply({ embeds: [new EmbedBuilder().setColor("Blurple").setTitle("💳 ยอดเงินคงเหลือของคุณ").setDescription(`บัญชีของคุณ: <@${interaction.user.id}>\n💰 ยอดเงินสะสม: **${balances[interaction.user.id] || 0} บาท**`)], ephemeral: true });
            }

            if (interaction.customId === "buy_menu") {
                const products = getProducts();
                if (products.length === 0) return interaction.reply({ content: "❌ ขณะนี้ยังไม่มีสินค้าเปิดขาย", ephemeral: true });

                const selectMenu = new StringSelectMenuBuilder().setCustomId('select_product').setPlaceholder('เลือกสินค้าที่คุณต้องการซื้อ');
                products.forEach(prod => {
                    let stockCount = prod.stock || 0;
                    let stockLabel = stockCount > 0 ? ` (เหลือ ${stockCount} ชิ้น)` : " (สินค้าหมด)";
                    selectMenu.addOptions({ label: prod.name + stockLabel, description: `ราคา ${prod.price} บาท | สต็อก: ${stockCount} ชิ้น`, value: prod.id });
                });

                return await interaction.reply({ content: "🛒 **โปรดเลือกสินค้าที่คุณต้องการซื้อจากรายการด้านล่าง:**", components: [new ActionRowBuilder().addComponents(selectMenu)], ephemeral: true });
            }

            if (interaction.customId === "view_prices") {
                const products = getProducts();
                let desc = "📋 **รายการสินค้าทั้งหมดที่มีจำหน่าย:**\n\n";
                if (products.length === 0) {
                    desc += "ยังไม่มีรายการสินค้า";
                } else {
                    products.forEach((p, index) => {
                        let stockCount = p.stock || 0;
                        let stockDisplay = stockCount > 0 ? `📦 สต็อกเหลือ: **${stockCount} ชิ้น**` : "❌ **สินค้าหมดสต็อก**";
                        let roleDisplay = (p.roleId && p.roleId !== "") ? `<@&${p.roleId}>` : "ไม่มี";
                        let descriptionText = (p.description && p.description.trim() !== "") ? `\n📝 **รายละเอียด:** ${p.description}` : "";
                        desc += `**${index + 1}. ${p.name}**\n💵 ราคา: **${p.price} บาท** | ${stockDisplay}${descriptionText}\n🏷️ ยศที่จะได้รับ: ${roleDisplay}\n-----------------------------------\n`;
                    });
                }
                return await interaction.reply({ embeds: [new EmbedBuilder().setColor("Green").setTitle("💰 รายการสินค้าและราคา").setDescription(desc)], ephemeral: true });
            }

            if (interaction.customId === "contact_admin") {
                return await interaction.reply({ embeds: [new EmbedBuilder().setColor("Orange").setTitle("🎫 ต้องการความช่วยเหลือ?").setDescription(`คุณสามารถติดต่อแอดมินหรือเปิดทิกเก็ตได้ที่ห้องนี้เลยครับ: <#${config.ticketChannelId}>`)], ephemeral: true });
            }

            // ปุ่ม Admin Control Room
            if (interaction.customId === "adm_prod_add") {
                if (!isAdmin(interaction)) return interaction.reply({ content: "❌ สำหรับ Admin เท่านั้น", ephemeral: true });
                return await interaction.showModal(buildAddProductModal());
            }

            if (interaction.customId === "adm_prod_del") {
                if (!isAdmin(interaction)) return interaction.reply({ content: "❌ สำหรับ Admin เท่านั้น", ephemeral: true });
                const products = getProducts();
                if (products.length === 0) return interaction.reply({ content: "❌ ยังไม่มีสินค้าในระบบให้ลบ", ephemeral: true });

                const selectMenu = new StringSelectMenuBuilder().setCustomId('select_delete_product').setPlaceholder('ถังขยะ: เลือกสินค้าที่ต้องการลบถาวร');
                products.forEach(prod => { selectMenu.addOptions({ label: `🗑️ ${prod.name}`, description: `ลบสินค้านี้ออกจากระบบ | ราคา: ${prod.price} บาท`, value: prod.id }); });
                return await interaction.reply({ content: "⚠️ **โปรดเลือกสินค้าที่คุณต้องการลบทิ้งถาวร:**", components: [new ActionRowBuilder().addComponents(selectMenu)], ephemeral: true });
            }

            if (interaction.customId === "adm_stock_add" || interaction.customId === "adm_stock_remove") {
                if (!isAdmin(interaction)) return interaction.reply({ content: "❌ สำหรับ Admin เท่านั้น", ephemeral: true });
                const products = getProducts();
                if (products.length === 0) return interaction.reply({ content: "❌ ยังไม่มีสินค้าในระบบ", ephemeral: true });

                const actionType = interaction.customId === "adm_stock_add" ? "add" : "remove";
                const selectMenu = new StringSelectMenuBuilder().setCustomId(`stock_action_${actionType}`).setPlaceholder('เลือกสินค้าที่ต้องการปรับสต็อก');
                products.forEach(prod => { selectMenu.addOptions({ label: prod.name, description: `สต็อกปัจจุบัน: ${prod.stock || 0} ชิ้น`, value: prod.id }); });
                return await interaction.reply({ content: `📦 **โปรดเลือกสินค้าที่ต้องการ${actionType === 'add' ? 'เพิ่ม' : 'ลด'}สต็อก:**`, components: [new ActionRowBuilder().addComponents(selectMenu)], ephemeral: true });
            }

            if (interaction.customId === "adm_stock_check") {
                if (!isAdmin(interaction)) return interaction.reply({ content: "❌ สำหรับ Admin เท่านั้น", ephemeral: true });
                const products = getProducts();
                const purchases = getPurchases();
                let desc = "📋 **รายงานสถานะสินค้าทั้งหมด:**\n\n";

                if (products.length === 0) {
                    desc += "ยังไม่มีสินค้าในระบบ";
                } else {
                    products.forEach((p, index) => {
                        let stockCount = p.stock || 0;
                        let totalSold = 0;
                        Object.values(purchases).forEach(userPurchases => {
                            if (Array.isArray(userPurchases)) {
                                userPurchases.forEach(up => { if (up.productName === p.name) totalSold++; });
                            }
                        });
                        let stockStatus = stockCount > 0 ? `📦 คงเหลือ: **${stockCount} ชิ้น**` : "❌ **สินค้าหมดสต็อก**";
                        desc += `**${index + 1}. ${p.name}**\n${stockStatus} | 🛒 ขายไปแล้ว: **${totalSold} ชิ้น** | 💵 ${p.price} บาท\n-----------------------------------\n`;
                    });
                }
                return await interaction.reply({ embeds: [new EmbedBuilder().setColor("Gold").setTitle("📊 ตรวจสอบสต็อกและสินค้า").setDescription(desc)], ephemeral: true });
            }

            if (interaction.customId === "adm_money_manage") {
                if (!isAdmin(interaction)) return interaction.reply({ content: "❌ สำหรับ Admin เท่านั้น", ephemeral: true });
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('money_btn_add').setLabel('💰 เพิ่มเงินลูกค้า').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId('money_btn_remove').setLabel('💸 หักเงินลูกค้า').setStyle(ButtonStyle.Danger)
                );
                return await interaction.reply({ content: "💳 **จัดการยอดเงินผ่านปุ่มลัด (กรอก ID):**", components: [row], ephemeral: true });
            }

            if (interaction.customId === "money_btn_add" || interaction.customId === "money_btn_remove") {
                if (!isAdmin(interaction)) return interaction.reply({ content: "❌ สำหรับ Admin เท่านั้น", ephemeral: true });
                const action = interaction.customId === "money_btn_add" ? "add" : "remove";
                const modal = new ModalBuilder().setCustomId(`money_modal_${action}`).setTitle(action === 'add' ? '💰 เพิ่มเงิน' : '💸 หักเงิน');
                const userIdInput = new TextInputBuilder().setCustomId('target_userid').setLabel("Discord ID ลูกค้า").setStyle(TextInputStyle.Short).setRequired(true);
                const amountInput = new TextInputBuilder().setCustomId('money_amount').setLabel("จำนวนเงิน").setStyle(TextInputStyle.Short).setRequired(true);
                modal.addComponents(new ActionRowBuilder().addComponents(userIdInput), new ActionRowBuilder().addComponents(amountInput));
                return await interaction.showModal(modal);
            }

            if (interaction.customId === "adm_user_check") {
                if (!isAdmin(interaction)) return interaction.reply({ content: "❌ สำหรับ Admin เท่านั้น", ephemeral: true });
                const modal = new ModalBuilder().setCustomId('user_check_modal').setTitle('🔍 ตรวจสอบผู้ใช้ผ่าน ID');
                const userIdInput = new TextInputBuilder().setCustomId('check_userid').setLabel("Discord ID ลูกค้า").setStyle(TextInputStyle.Short).setRequired(true);
                modal.addComponents(new ActionRowBuilder().addComponents(userIdInput));
                return await interaction.showModal(modal);
            }
        }

        // --- 3. Select Menus ---
        if (interaction.isStringSelectMenu()) {
            
            // ซื้อสินค้า
            if (interaction.customId === 'select_product') {
                const products = getProducts();
                const productId = interaction.values[0];
                const product = products.find(p => p.id === productId);

                if (!product) return interaction.update({ content: "❌ ไม่พบสินค้านี้ในระบบ", components: [] });

                const currentStock = product.stock || 0;
                if (currentStock <= 0) return interaction.update({ content: `❌ สินค้า **${product.name}** หมดสต็อก!`, components: [], ephemeral: true });

                const balances = getBalances();
                const userBalance = balances[interaction.user.id] || 0;

                if (userBalance < product.price) {
                    return interaction.update({ content: `❌ เงินไม่พอซื้อ **${product.name}**\n💰 เงินของคุณ: **${userBalance} บาท** | ต้องการ: **${product.price} บาท**`, components: [], ephemeral: true });
                }

                // ล็อกผู้ซื้อแต่ละคนชั่วคราว ป้องกันกดซื้อซ้อนจนยอด/สต็อกผิด
                const purchaseLockKey = `${interaction.user.id}:${product.id}`;
                if (purchaseLocks.has(purchaseLockKey)) {
                    return interaction.update({ content: "⏳ กำลังประมวลผลรายการก่อนหน้า กรุณารอสักครู่", components: [], ephemeral: true });
                }
                purchaseLocks.add(purchaseLockKey);

                try {
                    const latestProducts = getProducts();
                    const latestProduct = latestProducts.find(p => p.id === product.id);
                    if (!latestProduct || (latestProduct.stock || 0) <= 0) {
                        return interaction.update({ content: "❌ สินค้าหมดหรือถูกซื้อไปแล้ว กรุณาลองใหม่", components: [], ephemeral: true });
                    }

                    const latestBalances = getBalances();
                    const latestBalance = latestBalances[interaction.user.id] || 0;
                    if (latestBalance < latestProduct.price) {
                        return interaction.update({ content: `❌ เงินไม่พอซื้อ **${latestProduct.name}**\n💰 เงินของคุณ: **${latestBalance} บาท** | ต้องการ: **${latestProduct.price} บาท**`, components: [], ephemeral: true });
                    }

                    latestBalances[interaction.user.id] = latestBalance - latestProduct.price;
                    latestProduct.stock = (latestProduct.stock || 0) - 1;
                    saveBalances(latestBalances);
                    saveProducts(latestProducts);

                    const purchases = getPurchases();
                    if (!purchases[interaction.user.id]) purchases[interaction.user.id] = [];
                    purchases[interaction.user.id].push({ productName: latestProduct.name, price: latestProduct.price, date: new Date().toISOString() });
                    savePurchases(purchases);

                    balances[interaction.user.id] = latestBalances[interaction.user.id];
                    product.name = latestProduct.name;
                    product.price = latestProduct.price;
                    product.stock = latestProduct.stock;
                } finally {
                    purchaseLocks.delete(purchaseLockKey);
                }

                let roleStatusText = "";
                if (product.roleId && product.roleId !== "") {
                    try {
                        const member = await interaction.guild.members.fetch(interaction.user.id);
                        await member.roles.add(product.roleId);
                        roleStatusText = "\n🏷️ **ได้รับยศสำเร็จ!**";
                    } catch (err) {
                        roleStatusText = "\n⚠️ ซื้อสำเร็จ แต่ระบบมอบยศไม่ผ่าน (ตรวจสอบสิทธิ์บอท)";
                    }
                }

                const downloadLink = (product.gofileUrl && product.gofileUrl.trim() !== "") ? `[คลิกเพื่อดาวน์โหลด](${product.gofileUrl})` : "ไม่มีไฟล์ให้ดาวน์โหลด";
                const descDetails = (product.description && product.description.trim() !== "") ? `\n📝 **รายละเอียด:** ${product.description}` : "";

                const successEmbed = new EmbedBuilder()
                    .setColor("Green")
                    .setTitle("✅ สั่งซื้อสินค้าสำเร็จ!")
                    .setDescription(`คุณได้ซื้อ **${product.name}** เรียบร้อยแล้ว${roleStatusText}${descDetails}`)
                    .addFields(
                        { name: "🔗 ลิงก์สินค้า", value: downloadLink, inline: false },
                        { name: "💳 ยอดเงินคงเหลือ", value: `${balances[interaction.user.id]} บาท`, inline: false }
                    );

                if (product.previewImage && product.previewImage.trim() !== "") {
                    successEmbed.setImage(product.previewImage);
                }

                await interaction.update({ content: null, embeds: [successEmbed], components: [], ephemeral: true });

                const logChannel = interaction.guild.channels.cache.get(config.channellog);
                if (logChannel) {
                    logChannel.send({ embeds: [new EmbedBuilder().setTitle("🛒 มีออเดอร์ใหม่").setDescription(`ผู้ซื้อ: <@${interaction.user.id}>\nสินค้า: **${product.name}**\nราคา: **${product.price} บาท**\n📦 สต็อกคงเหลือ: **${product.stock} ชิ้น**`).setColor("Green").setTimestamp()] });
                }
            }

            // ลบสินค้า
            if (interaction.customId === 'select_delete_product') {
                let products = getProducts();
                const productId = interaction.values[0];
                const prodIndex = products.findIndex(p => p.id === productId);

                if (prodIndex > -1) {
                    const deletedName = products[prodIndex].name;
                    products.splice(prodIndex, 1);
                    saveProducts(products);
                    await interaction.update({ content: `✅ ลบสินค้า **${deletedName}** ออกจากร้านค้าถาวรแล้ว`, components: [], ephemeral: true });
                } else {
                    await interaction.update({ content: `❌ เกิดข้อผิดพลาด ไม่พบสินค้านี้`, components: [], ephemeral: true });
                }
            }

            // ปรับสต็อก
            if (interaction.customId === 'stock_action_add' || interaction.customId === 'stock_action_remove') {
                const productId = interaction.values[0];
                const action = interaction.customId.includes('add') ? 'add' : 'remove';

                const modal = new ModalBuilder().setCustomId(`stock_modal_${action}_${productId}`).setTitle(`📦 จำนวนสต็อกที่ต้องการ${action === 'add' ? 'เพิ่ม' : 'ลด'}`);
                const amountInput = new TextInputBuilder().setCustomId('stock_amount').setLabel("ใส่จำนวนตัวเลข").setStyle(TextInputStyle.Short).setRequired(true);
                modal.addComponents(new ActionRowBuilder().addComponents(amountInput));
                return await interaction.showModal(modal);
            }
        }

        // --- 4. Modal Submissions ---
        if (interaction.isModalSubmit()) {
            
            // เติมเงิน
            if (interaction.customId === "topup_modal") {
                const codeInput = interaction.fields.getTextInputValue('codeInput');
                await interaction.deferReply({ ephemeral: true }); 

                if (!codeInput.includes("gift.truemoney.com")) return await interaction.editReply({ embeds: [new EmbedBuilder().setColor("Red").setDescription('❌ เติมเงินไม่สำเร็จ: ลิ้งค์ซองไม่ถูกต้อง')] });

                tw(config.phone, codeInput).then(async (re) => {
                    const balances = getBalances();
                    if (!balances[interaction.user.id]) balances[interaction.user.id] = 0;
                    balances[interaction.user.id] += re.amount;
                    saveBalances(balances);

                    await interaction.editReply({ embeds: [new EmbedBuilder().setColor("Green").setTitle("✅ เติมเงินสำเร็จ!").setDescription(`ได้รับเงิน **${re.amount} บาท**\n💰 ยอดสะสม: **${balances[interaction.user.id]} บาท**`)] });

                    const logChannel = interaction.guild.channels.cache.get(config.channellog);
                    if (logChannel) logChannel.send({ embeds: [new EmbedBuilder().setTitle("💸 ประวัติการเติมเงิน").setDescription(`ผู้เติม: <@${interaction.user.id}>\nจำนวน: **${re.amount} บาท**`).setColor("Green").setTimestamp()] });
                }).catch(async () => {
                    await interaction.editReply({ embeds: [new EmbedBuilder().setColor("Red").setDescription("❌ เติมเงินไม่ผ่าน: ลิงก์ผิด, มีคนใช้แล้ว หรือหมดอายุ")] });
                });
            }

            // 🏦 สร้างรายการเติมเงินผ่าน QR / PromptPay / ธนาคาร
            if (interaction.customId === "bank_topup_modal") {
                const amount = normalizeMoney(interaction.fields.getTextInputValue('bank_amount'));
                const ref = (interaction.fields.getTextInputValue('bank_ref') || '').trim();

                if (!amount) {
                    return interaction.reply({ content: "❌ จำนวนเงินไม่ถูกต้อง กรุณากรอกเป็นตัวเลข เช่น 100", ephemeral: true });
                }

                const topupId = makeTopupId(interaction.user.id);

                const result = await queueDbWrite(async () => {
                    const topups = getTopups();
                    const existing = Object.values(topups).find(t =>
                        t.userId === interaction.user.id && ['awaiting_slip', 'pending'].includes(t.status)
                    );
                    if (existing) return { error: existing };

                    topups[topupId] = {
                        id: topupId,
                        userId: interaction.user.id,
                        amount,
                        reference: ref,
                        status: 'awaiting_slip',
                        createdAt: new Date().toISOString(),
                        slipMessageId: null,
                        slipUrl: null,
                        approvedBy: null,
                        approvedAt: null
                    };
                    saveTopups(topups);
                    return { topup: topups[topupId] };
                });

                if (result.error) {
                    return interaction.reply({
                        content: `⏳ คุณมีรายการเติมเงินค้างอยู่แล้ว: **${result.error.id}**\nกรุณาส่งสลิปของรายการเดิมก่อน`,
                        ephemeral: true
                    });
                }

                const topup = result.topup;
                const bankInfo = getBankTopupDescription();
                let qrBuffer = null;
                try {
                    qrBuffer = await createPromptPayQrBuffer(topup.amount);
                } catch (qrErr) {
                    console.error("PromptPay QR error:", qrErr);
                }

                const embed = new EmbedBuilder()
                    .setColor("Blue")
                    .setTitle("🏦 เติมเงินผ่าน PromptPay / ธนาคาร")
                    .setDescription(
                        `🧾 **รหัสรายการ:** \`${topup.id}\`\n` +
                        `💰 **จำนวนที่ต้องโอน:** **${topup.amount.toFixed(2)} บาท**\n\n` +
                        `${bankInfo}\n\n` +
                        (qrBuffer
                            ? `📱 **สแกน QR ด้านล่างได้เลย — ระบบใส่ยอด ${topup.amount.toFixed(2)} บาทให้แล้ว**\n\n`
                            : `⚠️ ยังสร้าง QR อัตโนมัติไม่ได้ กรุณาใช้เลขบัญชี/พร้อมเพย์ด้านบน\n\n`) +
                        `หลังโอนเสร็จ ให้ส่ง **รูปสลิปตัวจริง** ในห้อง <#${config.slipChannelId || config.ticketChannelId}>\n` +
                        `ระบบจะตรวจสลิปอัตโนมัติว่า **โอนจริง / จำนวนเงินตรง / เข้าบัญชีร้าน / สลิปซ้ำหรือไม่**\n\n` +
                        `🔒 **เงินจะเข้ายอดต่อเมื่อผ่านทุกเงื่อนไขเท่านั้น**`
                    );

                if (qrBuffer) embed.setImage('attachment://promptpay.png');
                else if (config.bankQrImageUrl && String(config.bankQrImageUrl).trim()) {
                    embed.setImage(String(config.bankQrImageUrl).trim());
                }

                return await interaction.reply({
                    embeds: [embed],
                    files: qrBuffer ? [new AttachmentBuilder(qrBuffer, { name: 'promptpay.png' })] : [],
                    ephemeral: true
                });
            }

            // ➕ เพิ่มสินค้าใหม่ (แยก 3 บรรทัด)
            if (interaction.customId === "setup2_modal") {
                await interaction.deferReply({ ephemeral: true }).catch(() => {});

                const rawName = interaction.fields.getTextInputValue('prod_name');
                const rawPrice = interaction.fields.getTextInputValue('prod_price');
                const rawStock = interaction.fields.getTextInputValue('prod_stock');
                const rawRole = interaction.fields.getTextInputValue('prod_role') || "";
                const rawDetails = interaction.fields.getTextInputValue('prod_links') || "";

                const cleanPrice = parseFloat(rawPrice.replace(/[^0-9.]/g, ''));
                const cleanStock = parseInt(rawStock.replace(/[^0-9]/g, ''));

                if (isNaN(cleanPrice) || cleanPrice < 0) {
                    return await interaction.editReply({ content: "❌ **ราคาไม่ถูกต้อง!** กรุณากรอกเฉพาะตัวเลข เช่น `100`" });
                }

                if (isNaN(cleanStock) || cleanStock < 0) {
                    return await interaction.editReply({ content: "❌ **สต็อกไม่ถูกต้อง!** กรุณากรอกเฉพาะตัวเลข เช่น `10`" });
                }

                const cleanRole = rawRole.replace(/[^0-9]/g, '');
                
                // แยกเป็น 3 บรรทัด
                const linesArr = rawDetails.split('\n').map(l => l.trim());
                const gofileUrl = linesArr[0] || "";      // บรรทัดที่ 1: ลิงก์ดาวน์โหลด
                const description = linesArr[1] || "";    // บรรทัดที่ 2: รายละเอียด
                const previewImage = linesArr[2] || "";   // บรรทัดที่ 3: รูปภาพ

                const products = getProducts();
                const newId = `prod_${Date.now()}`;

                const newProd = {
                    id: newId,
                    name: rawName.trim(),
                    price: cleanPrice,
                    stock: cleanStock,
                    roleId: cleanRole,
                    gofileUrl: gofileUrl,
                    description: description,
                    previewImage: previewImage
                };

                products.push(newProd);
                saveProducts(products);

                await interaction.editReply({
                    content: `✅ **เพิ่มสินค้าสำเร็จแล้วครับ!**\n\n📌 **ชื่อสินค้า:** ${newProd.name}\n💵 **ราคา:** ${newProd.price} บาท\n📦 **สต็อก:** ${newProd.stock} ชิ้น${description ? `\n📝 **รายละเอียด:** ${description}` : ''}${cleanRole ? `\n🏷️ **ยศ:** <@&${cleanRole}>` : ''}`
                });
            }

            // เพิ่ม/ลดสต็อก
            if (interaction.customId.startsWith('stock_modal_')) {
                const parts = interaction.customId.split('_');
                const action = parts[2];
                const productId = parts.slice(3).join('_');
                const rawAmount = interaction.fields.getTextInputValue('stock_amount');
                const inputAmount = parseInt(rawAmount.replace(/[^0-9]/g, ''));

                if (isNaN(inputAmount) || inputAmount <= 0) return interaction.reply({ content: "❌ กรุณากรอกจำนวนตัวเลขที่ถูกต้อง", ephemeral: true });

                const products = getProducts();
                const product = products.find(p => p.id === productId);
                if (!product) return interaction.reply({ content: "❌ ไม่พบสินค้านี้", ephemeral: true });

                if (product.stock === undefined) product.stock = 0;
                if (action === 'add') product.stock += inputAmount;
                else product.stock = Math.max(0, product.stock - inputAmount);

                saveProducts(products);
                await interaction.reply({ content: `✅ อัปเดตสต็อก **${product.name}** เรียบร้อย!\n📦 คงเหลือปัจจุบัน: **${product.stock} ชิ้น**`, ephemeral: true });
            }

            // จัดการเงินผ่าน Modal
            if (interaction.customId === 'money_modal_add' || interaction.customId === 'money_modal_remove') {
                const action = interaction.customId.includes('add') ? 'add' : 'remove';
                const targetUserId = interaction.fields.getTextInputValue('target_userid').trim();
                const rawAmount = interaction.fields.getTextInputValue('money_amount');
                const amount = parseInt(rawAmount.replace(/[^0-9]/g, ''));

                if (isNaN(amount) || amount <= 0) return interaction.reply({ content: "❌ จำนวนเงินไม่ถูกต้อง", ephemeral: true });

                const balances = getBalances();
                if (!balances[targetUserId]) balances[targetUserId] = 0;
                if (action === 'add') balances[targetUserId] += amount;
                else balances[targetUserId] = Math.max(0, balances[targetUserId] - amount);
                saveBalances(balances);

                await interaction.reply({ content: `✅ ${action === 'add' ? 'เพิ่มเงิน' : 'หักเงิน'}สำเร็จ\n👤 ID: \`${targetUserId}\` | 💰 คงเหลือ: **${balances[targetUserId]} บาท**`, ephemeral: true });
            }

            // เช็คผู้ใช้ผ่าน Modal
            if (interaction.customId === 'user_check_modal') {
                const targetUserId = interaction.fields.getTextInputValue('check_userid').trim();
                const balances = getBalances();
                const purchases = getPurchases();

                const userBalance = balances[targetUserId] || 0;
                const userPurchases = purchases[targetUserId] || [];
                let purchaseHistory = userPurchases.length > 0 ? userPurchases.map(p => `• **${p.productName}** (${p.price} บาท)`).join('\n') : "ไม่มีประวัติการซื้อ";

                const embed = new EmbedBuilder().setColor("Purple").setTitle(`🔍 ข้อมูลผู้ใช้ ID: ${targetUserId}`).addFields({ name: "💳 เงินคงเหลือ", value: `${userBalance} บาท`, inline: true }, { name: "🛒 ประวัติการซื้อ", value: purchaseHistory, inline: false });
                return await interaction.reply({ embeds: [embed], ephemeral: true });
            }
        }
    } catch (error) {
        console.error('Interaction Error:', error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: '❌ เกิดข้อผิดพลาดในระบบ กรุณาลองใหม่อีกครั้ง', ephemeral: true }).catch(() => {});
        }
    }
});


// ---------------------------------------------------------
// รับสลิป + ตรวจสอบกับ EasySlip อัตโนมัติ
// ---------------------------------------------------------
client.on('messageCreate', async (message) => {
    try {
        if (message.author.bot) return;
        if (!config.slipChannelId || message.channel.id !== config.slipChannelId) return;

        const attachment = message.attachments.find(a => {
            const type = a.contentType || '';
            return type.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(a.name || '');
        });
        if (!attachment) return;

        const codeMatch = message.content.match(/BANK-[A-Z0-9-]+/i);
        const topupsBefore = getTopups();

        // ถ้าไม่พิมพ์รหัส ให้ใช้รายการค้างของผู้ใช้ (ผู้ใช้หนึ่งคนมีได้ทีละรายการ)
        let topup = codeMatch ? topupsBefore[codeMatch[0].toUpperCase()] : null;
        if (!topup) {
            topup = Object.values(topupsBefore).find(t =>
                t.userId === message.author.id && t.status === 'awaiting_slip'
            );
        }

        if (!topup) {
            return message.reply("❌ ไม่พบรายการเติมเงินที่รอรับสลิปของคุณ กรุณากด **เติมผ่าน QR/ธนาคาร** ก่อน");
        }

        if (topup.userId !== message.author.id) {
            return message.reply("❌ รายการนี้ไม่ใช่ของคุณ ไม่สามารถนำสลิปมาเข้าบัญชีผู้อื่นได้");
        }

        // เปลี่ยนสถานะเป็น verifying ก่อนเรียก API เพื่อกันการส่งสลิปซ้ำพร้อมกัน
        const locked = await queueDbWrite(async () => {
            const topups = getTopups();
            const current = topups[topup.id];
            if (!current || current.userId !== message.author.id) return { error: "ไม่พบรายการ" };
            if (current.status !== 'awaiting_slip') return { error: "รายการนี้กำลังตรวจสอบหรือดำเนินการไปแล้ว" };

            current.status = 'verifying';
            current.slipMessageId = message.id;
            current.slipUrl = attachment.url;
            current.submittedAt = new Date().toISOString();
            saveTopups(topups);
            return { topup: current };
        });

        if (locked.error) return message.reply(`⏳ ${locked.error}`);

        const currentTopup = locked.topup;

        let verification;
        try {
            verification = await verifyBankSlipByUrl(
                currentTopup.slipUrl,
                currentTopup.amount,
                currentTopup.id
            );
        } catch (err) {
            console.error("EasySlip verification error:", err);

            await queueDbWrite(async () => {
                const topups = getTopups();
                if (topups[currentTopup.id] && topups[currentTopup.id].status === 'verifying') {
                    topups[currentTopup.id].status = 'awaiting_slip';
                    topups[currentTopup.id].lastError = String(err.message || err);
                    saveTopups(topups);
                }
            });

            return message.reply(
                `⚠️ **ยังตรวจสอบสลิปไม่ได้**\n` +
                `รายการ: \`${currentTopup.id}\`\\n` +
                `สาเหตุ: ${String(err.message || err)}\\n\\n` +
                `กรุณาลองส่งสลิปใหม่อีกครั้ง`
            );
        }

        const duplicate = verification.isDuplicate;
        const amountMatched = verification.isAmountMatched;
        const accountMatched = !!verification.matchedAccount;
        const transRef = verification.transRef;

        // ตรวจ transRef ซ้ำในฐานข้อมูลเราอีกชั้น
        const topupsNow = getTopups();
        const localTransRefUsed = transRef && Object.values(topupsNow).some(t =>
            t.id !== currentTopup.id &&
            t.status === 'approved' &&
            t.transRef === transRef
        );

        const verified = !duplicate && !localTransRefUsed && amountMatched && accountMatched && !!transRef;

        if (!verified) {
            await queueDbWrite(async () => {
                const topups = getTopups();
                const t = topups[currentTopup.id];
                if (!t) return;

                t.status = 'rejected';
                t.rejectedAt = new Date().toISOString();
                t.transRef = transRef || null;
                t.verification = {
                    isDuplicate: duplicate,
                    isAmountMatched: amountMatched,
                    accountMatched,
                    amountInSlip: verification.amount,
                    localTransRefUsed
                };
                saveTopups(topups);
            });

            return message.reply(
                `❌ **สลิปไม่ผ่านการตรวจสอบ**\n` +
                `🧾 รายการ: \`${currentTopup.id}\`\\n` +
                `💰 ยอดที่ต้องโอน: **${currentTopup.amount.toFixed(2)} บาท**\\n` +
                `💵 ยอดในสลิป: **${Number(verification.amount || 0).toFixed(2)} บาท**\\n` +
                `📌 จำนวนเงินตรง: ${amountMatched ? '✅' : '❌'}\\n` +
                `🏦 บัญชีผู้รับตรงกับบัญชีร้าน: ${accountMatched ? '✅' : '❌'}\\n` +
                `♻️ สลิปซ้ำ: ${duplicate || localTransRefUsed ? '❌' : '✅'}\\n\\n` +
                `ระบบ **ยังไม่เพิ่มเงิน** ให้บัญชีคุณ`
            );
        }

        // อนุมัติอัตโนมัติใน critical section เดียว ป้องกันเงินเข้า 2 ครั้ง
        const approved = await queueDbWrite(async () => {
            const topups = getTopups();
            const t = topups[currentTopup.id];

            if (!t || t.status !== 'verifying') return { error: "รายการนี้ถูกดำเนินการไปแล้ว" };

            const balances = getBalances();
            if (!balances[t.userId]) balances[t.userId] = 0;

            balances[t.userId] += Number(t.amount);
            saveBalances(balances);

            t.status = 'approved';
            t.transRef = transRef;
            t.approvedAt = new Date().toISOString();
            t.balanceAfter = balances[t.userId];
            t.verification = {
                isDuplicate: duplicate,
                isAmountMatched: amountMatched,
                accountMatched,
                amountInSlip: verification.amount,
                receiver: verification.matchedAccount,
                transRef
            };
            saveTopups(topups);

            return { balance: balances[t.userId], topup: t };
        });

        if (approved.error) return message.reply(`❌ ${approved.error}`);

        await message.reply(
            `✅ **เติมเงินสำเร็จ — ระบบตรวจสอบสลิปผ่านแล้ว**\n` +
            `🧾 รายการ: \`${currentTopup.id}\`\\n` +
            `💰 ได้รับ: **${currentTopup.amount.toFixed(2)} บาท**\\n` +
            `🔐 ตรวจสอบบัญชีผู้รับ: ✅\\n` +
            `🔐 ตรวจสอบจำนวนเงิน: ✅\\n` +
            `🔐 ตรวจสอบสลิปซ้ำ: ✅\\n` +
            `🔐 ตรวจสอบเลขอ้างอิงธุรกรรม: ✅\\n` +
            `💳 ยอดคงเหลือใหม่: **${approved.balance.toFixed(2)} บาท**`
        );

        const logChannel = message.guild?.channels.cache.get(config.channellog);
        if (logChannel) {
            await logChannel.send({
                embeds: [new EmbedBuilder()
                    .setColor("Green")
                    .setTitle("🏦 เติมเงินธนาคารสำเร็จ (Auto Verified)")
                    .setDescription(
                        `👤 ผู้เติม: <@${currentTopup.userId}>\\n` +
                        `🧾 รายการ: \`${currentTopup.id}\`\\n` +
                        `💰 จำนวน: **${currentTopup.amount.toFixed(2)} บาท**\\n` +
                        `🔖 TransRef: \`${transRef}\`\\n` +
                        `🏦 บัญชีผู้รับ: ✅ ตรงกับบัญชีที่ลงทะเบียน EasySlip\\n` +
                        `♻️ สลิปซ้ำ: ❌\\n` +
                        `💳 ยอดหลังเติม: **${approved.balance.toFixed(2)} บาท**`
                    )
                    .setTimestamp()]
            });
        }
    } catch (err) {
        console.error("Slip processing error:", err);
    }
});

process.on('unhandledRejection', (reason, p) => console.log(' [Anti-Crash] :: Unhandled Rejection', reason));
process.on('uncaughtException', (err, origin) => console.log(' [Anti-Crash] :: Uncaught Exception', err));

client.login(botToken);
