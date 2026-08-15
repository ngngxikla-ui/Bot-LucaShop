const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Bot LucaShop is running 24/7!');
});

app.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
});

const { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, ActivityType, AttachmentBuilder } = require('discord.js');

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel, Partials.Message]
});

const tw = require('@fortune-inc/tw-voucher');
const config = require('./config.json');
const { REST } = require("@discordjs/rest");
const { Routes } = require("discord-api-types/v9");
const fs = require('fs');
const chalk = require('chalk');
const QRCode = require('qrcode');

// ⏱️ ตั้งค่าเวลาหมดอายุของการเติมเงิน (นาที)
const BANK_TOPUP_TIMEOUT_MINUTES = 5; 

// ตัวแปรเก็บสถานะผู้ใช้ที่กำลังรอส่งสลิปในแชท
const awaitingSlipUsers = new Map();

// ฟังก์ชันสร้าง PromptPay Payload
function generatePayload(target, options = {}) {
    const amount = options.amount;
    const sanitized = String(target || '').replace(/[^0-9]/g, '');
    let targetType = '01';
    let targetFormatted = sanitized;

    if (sanitized.length === 10 && sanitized.startsWith('0')) {
        targetType = '01';
        targetFormatted = '0066' + sanitized.substring(1);
    } else if (sanitized.length === 13) {
        targetType = '02';
        targetFormatted = sanitized;
    }

    const tag29_00 = '0016A000000677010111';
    const tag29_01 = `${targetType}${String(targetFormatted.length).padStart(2, '0')}${targetFormatted}`;
    const tag29Val = tag29_00 + tag29_01;
    const tag29 = `29${String(tag29Val.length).padStart(2, '0')}${tag29Val}`;

    const tag00 = '000201';
    const tag01 = amount ? '010212' : '010211';
    const tag53 = '5303764';
    const tag58 = '5802TH';

    let raw = tag00 + tag01 + tag29 + tag53;
    if (amount !== undefined && amount !== null && amount !== '') {
        const amtStr = Number(amount).toFixed(2);
        raw += `54${String(amtStr.length).padStart(2, '0')}${amtStr}`;
    }
    raw += tag58 + '6304';

    let crc = 0xFFFF;
    for (let i = 0; i < raw.length; i++) {
        let x = ((crc >> 8) ^ raw.charCodeAt(i)) & 0xFF;
        x ^= x >> 4;
        crc = ((crc << 8) ^ (x << 12) ^ (x << 5) ^ x) & 0xFFFF;
    }
    return raw + crc.toString(16).toUpperCase().padStart(4, '0');
}

const botToken = process.env.TOKEN || config.token;

// ---------------------------------------------------------
// ระบบฐานข้อมูล Topup
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
    if (!apiKey) throw new Error('ยังไม่ได้ตั้ง EASYSLIP_API_KEY ใน config.json');

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
// ระบบฐานข้อมูล JSON Files
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
// Register Slash Commands
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

function createShopMenu() {
    const embed = new EmbedBuilder()
        .setTitle('🛒 LucaShop')
        .setDescription('• เติมเงินผ่านซองทรูมันนี่ หรือ QR/PromptPay/ธนาคาร\n• โอนเสร็จแล้วกดปุ่มแนบสลิปเพื่อยืนยันยอดได้ทันที\n• เลือกซื้อสินค้าและโปรแกรมได้ทันทีผ่านปุ่มด้านล่าง')
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

function getAdminPanel() {
    const embed = new EmbedBuilder()
        .setColor("DarkButNotBlack")
        .setTitle("⚙️ แผงควบคุมระบบแอดมิน (Control Room)")
        .setDescription("จัดการร้านค้าของคุณได้อย่างสะดวกรวดเร็ว")
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

function buildAddProductModal() {
    const modal = new ModalBuilder().setCustomId('setup2_modal').setTitle('➕ เพิ่มสินค้าเข้าสู่ระบบ');

    const nameInput = new TextInputBuilder().setCustomId('prod_name').setLabel("ชื่อสินค้า").setPlaceholder("เช่น ไอดี Roblox").setStyle(TextInputStyle.Short).setRequired(true);
    const priceInput = new TextInputBuilder().setCustomId('prod_price').setLabel("ราคา (บาท)").setPlaceholder("เช่น 50").setStyle(TextInputStyle.Short).setRequired(true);
    const stockInput = new TextInputBuilder().setCustomId('prod_stock').setLabel("จำนวนสต็อก").setPlaceholder("เช่น 10").setStyle(TextInputStyle.Short).setRequired(true);
    const roleInput = new TextInputBuilder().setCustomId('prod_role').setLabel("Role ID ยศที่จะได้รับ (เว้นว่างได้)").setStyle(TextInputStyle.Short).setRequired(false);
    const detailsInput = new TextInputBuilder().setCustomId('prod_links').setLabel("บรรทัด 1:ลิงก์ | 2:รายละเอียด | 3:รูป").setStyle(TextInputStyle.Paragraph).setRequired(false);

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
// ฟังก์ชันประมวลผลการตรวจสลิป
// ---------------------------------------------------------
async function processSlipVerification(user, channel, attachment, topupId) {
    const topup = getTopups()[topupId];
    if (!topup) return;

    let verification;
    try {
        verification = await verifyBankSlipByUrl(attachment.url, topup.amount, topup.id);
    } catch (err) {
        console.error("EasySlip verification error:", err);
        return await channel.send({
            content: `<@${user.id}>`,
            embeds: [new EmbedBuilder()
                .setColor("Red")
                .setTitle("⚠️ ตรวจสอบสลิปไม่ผ่าน")
                .setDescription(`**สาเหตุ:** ${err.message || err}\nกรุณาลองแนบรูปสลิปใหม่อีกครั้งครับ`)]
        });
    }

    const duplicate = verification.isDuplicate;
    const amountMatched = verification.isAmountMatched;
    const accountMatched = !!verification.matchedAccount;
    const transRef = verification.transRef;

    const topupsNow = getTopups();
    const localTransRefUsed = transRef && Object.values(topupsNow).some(t =>
        t.id !== topup.id && t.status === 'approved' && t.transRef === transRef
    );

    const verified = !duplicate && !localTransRefUsed && amountMatched && accountMatched && !!transRef;

    if (!verified) {
        await queueDbWrite(async () => {
            const topups = getTopups();
            if (topups[topup.id]) {
                topups[topup.id].status = 'rejected';
                saveTopups(topups);
            }
        });

        return await channel.send({
            content: `<@${user.id}>`,
            embeds: [new EmbedBuilder()
                .setColor("Red")
                .setTitle("❌ สลิปไม่ผ่านการตรวจสอบ")
                .setDescription(
                    `🧾 รายการ: \`${topup.id}\`\n` +
                    `💰 ยอดที่ต้องโอน: **${topup.amount.toFixed(2)} บาท**\n` +
                    `💵 ยอดในสลิป: **${Number(verification.amount || 0).toFixed(2)} บาท**\n` +
                    `📌 ยอดเงินตรง: ${amountMatched ? '✅' : '❌'}\n` +
                    `🏦 บัญชีผู้รับตรง: ${accountMatched ? '✅' : '❌'}\n` +
                    `♻️ สลิปซ้ำ: ${duplicate || localTransRefUsed ? '❌' : '✅'}`
                )]
        });
    }

    const approved = await queueDbWrite(async () => {
        const topups = getTopups();
        const t = topups[topup.id];
        if (!t || t.status === 'approved') return null;

        const balances = getBalances();
        if (!balances[t.userId]) balances[t.userId] = 0;
        balances[t.userId] += Number(t.amount);
        saveBalances(balances);

        t.status = 'approved';
        t.transRef = transRef;
        t.approvedAt = new Date().toISOString();
        t.balanceAfter = balances[t.userId];
        saveTopups(topups);

        return { balance: balances[t.userId], topup: t };
    });

    if (!approved) return;

    await channel.send({
        content: `<@${user.id}>`,
        embeds: [new EmbedBuilder()
            .setColor("Green")
            .setTitle("✅ เติมเงินสำเร็จ!")
            .setDescription(
                `🧾 **รหัสรายการ:** \`${topup.id}\`\n` +
                `💰 **ยอดเงินที่ได้รับ:** **${topup.amount.toFixed(2)} บาท**\n` +
                `💳 **ยอดเงินคงเหลือใหม่:** **${approved.balance.toFixed(2)} บาท**`
            )]
    });

    // ส่ง Log สำหรับแอดมิน
    const logChannel = channel.guild?.channels.cache.get(config.channellog);
    if (logChannel) {
        await logChannel.send({
            embeds: [new EmbedBuilder()
                .setColor("Green")
                .setTitle("🏦 เติมเงินสำเร็จ (Auto Verified)")
                .setDescription(`👤 ผู้เติม: <@${topup.userId}>\n🧾 รายการ: \`${topup.id}\`\n💰 จำนวน: **${topup.amount.toFixed(2)} บาท**\n💳 ยอดสะสม: **${approved.balance.toFixed(2)} บาท**`)
                .setTimestamp()]
        });
    }
}

// ---------------------------------------------------------
// Interaction Handler
// ---------------------------------------------------------
client.on("interactionCreate", async (interaction) => {
    try {
        if (interaction.isChatInputCommand()) {
            if (!isAdmin(interaction)) return interaction.reply({ content: "❌ สำหรับ Admin เท่านั้น", ephemeral: true });

            if (interaction.commandName === 'setup') return await interaction.reply(createShopMenu());
            if (interaction.commandName === 'admin_room') return await interaction.reply(getAdminPanel());
            if (interaction.commandName === 'addproduct') return await interaction.showModal(buildAddProductModal());
        }

        if (interaction.isButton()) {

            // 📸 ปุ่มกดเริ่มแนบสลิปโอนเงิน
            if (interaction.customId.startsWith('upload_slip_')) {
                const topupId = interaction.customId.replace('upload_slip_', '');
                const topup = getTopups()[topupId];

                if (!topup || topup.status === 'expired' || topup.status === 'cancelled') {
                    return interaction.reply({ content: "❌ รายการนี้หมดอายุหรือถูกยกเลิกไปแล้ว กรุณากดเติมเงินใหม่ครับ", ephemeral: true });
                }

                awaitingSlipUsers.set(interaction.user.id, {
                    topupId: topupId,
                    channelId: interaction.channelId,
                    expiresAt: Date.now() + (3 * 60 * 1000) // รอสลิป 3 นาที
                });

                return await interaction.reply({
                    content: `📥 **กรุณาส่ง/แนบรูปภาพสลิปของคุณลงในช่องแชทนี้ได้เลยครับ!**\n*(ระบบกำลังรอรับรูปสลิปจากคุณเป็นเวลา 3 นาที...)*`,
                    ephemeral: true
                });
            }

            // ❌ ปุ่มยกเลิกรายการ
            if (interaction.customId.startsWith('cancel_topup_')) {
                const topupId = interaction.customId.replace('cancel_topup_', '');
                await queueDbWrite(async () => {
                    const topups = getTopups();
                    if (topups[topupId]) {
                        topups[topupId].status = 'cancelled';
                        saveTopups(topups);
                    }
                });
                awaitingSlipUsers.delete(interaction.user.id);
                return await interaction.reply({ content: `🗑️ ยกเลิกรายการ \`${topupId}\` เรียบร้อยแล้ว`, ephemeral: true });
            }

            if (interaction.customId === "topup_menu") {
                const modal = new ModalBuilder().setCustomId('topup_modal').setTitle('เติมเงินด้วยซองอั่งเปา TrueMoney');
                const codeInput = new TextInputBuilder().setCustomId('codeInput').setLabel("ใส่ลิ้งค์ซองอังเปาที่นี่").setStyle(TextInputStyle.Short).setRequired(true);
                modal.addComponents(new ActionRowBuilder().addComponents(codeInput));
                return await interaction.showModal(modal);
            }

            if (interaction.customId === "bank_topup_menu") {
                const topups = getTopups();
                const now = Date.now();
                const timeoutMs = BANK_TOPUP_TIMEOUT_MINUTES * 60 * 1000;

                // เคลียร์รายการหมดอายุ
                Object.values(topups).forEach(t => {
                    if (['awaiting_slip', 'pending'].includes(t.status)) {
                        if (now - new Date(t.createdAt).getTime() > timeoutMs) {
                            t.status = 'expired';
                        }
                    }
                });
                saveTopups(topups);

                const existing = Object.values(topups).find(t =>
                    t.userId === interaction.user.id && ['awaiting_slip', 'pending'].includes(t.status)
                );

                if (existing) {
                    const actionRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`upload_slip_${existing.id}`).setLabel('📸 แนบรูปสลิปยืนยัน').setStyle(ButtonStyle.Success),
                        new ButtonBuilder().setCustomId(`cancel_topup_${existing.id}`).setLabel('❌ ยกเลิกรายการนี้').setStyle(ButtonStyle.Danger)
                    );

                    return interaction.reply({
                        embeds: [new EmbedBuilder()
                            .setColor("Orange")
                            .setTitle("⏳ มีรายการเติมเงินที่ยังทำไม่เสร็จ")
                            .setDescription(`🧾 รหัสรายการ: \`${existing.id}\`\n💰 ยอดที่ต้องโอน: **${existing.amount.toFixed(2)} บาท**`)
                        ],
                        components: [actionRow],
                        ephemeral: true
                    });
                }

                const modal = new ModalBuilder().setCustomId('bank_topup_modal').setTitle('🏦 เติมเงินผ่าน QR / PromptPay / ธนาคาร');
                const amountInput = new TextInputBuilder().setCustomId('bank_amount').setLabel("จำนวนเงินที่โอน (บาท)").setPlaceholder("เช่น 100").setStyle(TextInputStyle.Short).setRequired(true);
                modal.addComponents(new ActionRowBuilder().addComponents(amountInput));
                return await interaction.showModal(modal);
            }

            if (interaction.customId === "check_balance") {
                const balances = getBalances();
                return await interaction.reply({ embeds: [new EmbedBuilder().setColor("Blurple").setTitle("💳 ยอดเงินคงเหลือ").setDescription(`💰 ยอดคงเหลือ: **${balances[interaction.user.id] || 0} บาท**`)], ephemeral: true });
            }

            if (interaction.customId === "buy_menu") {
                const products = getProducts();
                if (products.length === 0) return interaction.reply({ content: "❌ ขณะนี้ยังไม่มีสินค้าเปิดขาย", ephemeral: true });

                const selectMenu = new StringSelectMenuBuilder().setCustomId('select_product').setPlaceholder('เลือกสินค้าที่คุณต้องการซื้อ');
                products.forEach(prod => {
                    let stockCount = prod.stock || 0;
                    selectMenu.addOptions({ label: `${prod.name} (เหลือ ${stockCount} ชิ้น)`, description: `ราคา ${prod.price} บาท`, value: prod.id });
                });

                return await interaction.reply({ content: "🛒 **โปรดเลือกสินค้าที่ต้องการซื้อ:**", components: [new ActionRowBuilder().addComponents(selectMenu)], ephemeral: true });
            }
        }

        // --- Select Menus & Modals ---
        if (interaction.isStringSelectMenu()) {
            if (interaction.customId === 'select_product') {
                const products = getProducts();
                const product = products.find(p => p.id === interaction.values[0]);

                if (!product || (product.stock || 0) <= 0) return interaction.update({ content: "❌ สินค้าหมดสต็อก", components: [] });

                const balances = getBalances();
                const userBalance = balances[interaction.user.id] || 0;
                if (userBalance < product.price) return interaction.update({ content: `❌ เงินไม่พอซื้อ (ต้องการ ${product.price} บาท | มีอยู่ ${userBalance} บาท)`, components: [] });

                balances[interaction.user.id] -= product.price;
                product.stock -= 1;
                saveBalances(balances);
                saveProducts(products);

                const downloadLink = (product.gofileUrl && product.gofileUrl.trim() !== "") ? `[คลิกเพื่อดาวน์โหลด](${product.gofileUrl})` : "ไม่มีไฟล์ให้ดาวน์โหลด";
                return await interaction.update({
                    content: null,
                    embeds: [new EmbedBuilder().setColor("Green").setTitle("✅ สั่งซื้อสำเร็จ!").setDescription(`คุณได้ซื้อ **${product.name}** เรียบร้อยแล้ว\n🔗 **ลิงก์สินค้า:** ${downloadLink}\n💳 **ยอดคงเหลือ:** ${balances[interaction.user.id]} บาท`)],
                    components: [],
                    ephemeral: true
                });
            }
        }

        if (interaction.isModalSubmit()) {
            if (interaction.customId === "bank_topup_modal") {
                const amount = normalizeMoney(interaction.fields.getTextInputValue('bank_amount'));
                if (!amount) return interaction.reply({ content: "❌ กรุณากรอกจำนวนเงินเป็นตัวเลข", ephemeral: true });

                const topupId = makeTopupId(interaction.user.id);
                const topups = getTopups();

                topups[topupId] = {
                    id: topupId,
                    userId: interaction.user.id,
                    amount,
                    status: 'awaiting_slip',
                    createdAt: new Date().toISOString()
                };
                saveTopups(topups);

                let qrBuffer = null;
                try { qrBuffer = await createPromptPayQrBuffer(amount); } catch (e) {}

                const expireUnix = Math.floor((Date.now() + (BANK_TOPUP_TIMEOUT_MINUTES * 60 * 1000)) / 1000);

                const embed = new EmbedBuilder()
                    .setColor("Blue")
                    .setTitle("🏦 รายละเอียดการโอนเงิน")
                    .setDescription(
                        `🧾 **รหัสรายการ:** \`${topupId}\`\n` +
                        `💰 **ยอดที่ต้องโอน:** **${amount.toFixed(2)} บาท**\n` +
                        `⏰ **หมดอายุใน:** <t:${expireUnix}:R>\n\n` +
                        `${getBankTopupDescription()}\n\n` +
                        `📌 **ขั้นตอนการยืนยัน:**\n` +
                        `1. โอนเงินตามยอดด้านบน\n` +
                        `2. โอนเสร็จแล้ว ให้กดปุ่ม **"📸 แนบรูปสลิปยืนยัน"** ด้านล่าง\n` +
                        `3. ส่งรูปสลิปเข้าแชทได้ทันที ระบบจะตรวจสลิปและเข้ายอดเงินให้อัตโนมัติ!`
                    );

                if (qrBuffer) embed.setImage('attachment://promptpay.png');

                const actionRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`upload_slip_${topupId}`).setLabel('📸 แนบรูปสลิปยืนยัน').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId(`cancel_topup_${topupId}`).setLabel('❌ ยกเลิกรายการนี้').setStyle(ButtonStyle.Danger)
                );

                return await interaction.reply({
                    embeds: [embed],
                    components: [actionRow],
                    files: qrBuffer ? [new AttachmentBuilder(qrBuffer, { name: 'promptpay.png' })] : [],
                    ephemeral: true
                });
            }
        }
    } catch (err) {
        console.error(err);
    }
});

// ---------------------------------------------------------
// ดักจับรูปสลิปที่ผู้ใช้ส่งลงในช่องแชทแบบอัตโนมัติ
// ---------------------------------------------------------
client.on('messageCreate', async (message) => {
    try {
        if (message.author.bot) return;

        // เช็คว่าผู้ใช้นี้กำลังรอยืนยันสลิปอยู่หรือไม่
        const pending = awaitingSlipUsers.get(message.author.id);
        if (!pending) return;

        if (Date.now() > pending.expiresAt) {
            awaitingSlipUsers.delete(message.author.id);
            return;
        }

        const attachment = message.attachments.find(a => {
            const type = a.contentType || '';
            return type.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(a.name || '');
        });

        if (!attachment) return;

        // ลบข้อความสลิปของผู้ใช้ออกเพื่อความสะอาดของช่องแชท (ถ้าลบได้)
        message.delete().catch(() => {});

        // ลบสถานะรอ
        awaitingSlipUsers.delete(message.author.id);

        const loadingMsg = await message.channel.send(`⏳ กำลังตรวจสอบรูปสลิปของคุณสำหรับรายการ \`${pending.topupId}\`...`);
        
        // ประมวลผลตรวจสอบสลิป
        await processSlipVerification(message.author, message.channel, attachment, pending.topupId);
        
        loadingMsg.delete().catch(() => {});
    } catch (err) {
        console.error("Auto slip handler error:", err);
    }
});

process.on('unhandledRejection', (reason) => console.log(' [Anti-Crash] :: Unhandled Rejection', reason));
process.on('uncaughtException', (err) => console.log(' [Anti-Crash] :: Uncaught Exception', err));

client.login(botToken);
