const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Bot LucaShop is running 24/7!');
});

app.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
});

const { 
    Client, 
    GatewayIntentBits, 
    Partials, 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle, 
    StringSelectMenuBuilder, 
    ActivityType, 
    AttachmentBuilder,
    SlashCommandBuilder
} = require('discord.js');

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

const BANK_TOPUP_TIMEOUT_MINUTES = 5; 
const awaitingSlipUsers = new Map();

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

// Database Files
const TOPUP_FILE = './topups.json';
const DB_FILE = './balances.json';
const PRODUCTS_FILE = './products.json';
const GIVEAWAYS_FILE = './giveaways.json';

let dbWriteQueue = Promise.resolve();

function getTopups() {
    if (!fs.existsSync(TOPUP_FILE)) fs.writeFileSync(TOPUP_FILE, JSON.stringify({}, null, 4));
    try { return JSON.parse(fs.readFileSync(TOPUP_FILE, 'utf8')); } catch { return {}; }
}
function saveTopups(data) {
    const tmp = `${TOPUP_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 4));
    fs.renameSync(tmp, TOPUP_FILE);
}
function getBalances() {
    if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({}));
    try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return {}; }
}
function saveBalances(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 4));
}
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
function getGiveaways() {
    if (!fs.existsSync(GIVEAWAYS_FILE)) fs.writeFileSync(GIVEAWAYS_FILE, JSON.stringify({}, null, 4));
    try { return JSON.parse(fs.readFileSync(GIVEAWAYS_FILE, 'utf8')); } catch { return {}; }
}
function saveGiveaways(data) {
    fs.writeFileSync(GIVEAWAYS_FILE, JSON.stringify(data, null, 4));
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
    ].join('
');
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
// Slash Commands Definition
// ---------------------------------------------------------
const commands = [
    new SlashCommandBuilder().setName("setup").setDescription("ติดตั้งหน้าต่างเมนูร้านค้าสำหรับลูกค้า (Admin Only)"),
    new SlashCommandBuilder().setName("setupadmincontrol").setDescription("ติดตั้งแผงควบคุมระบบสำหรับแอดมิน (Control Room)"),
    new SlashCommandBuilder().setName("add-product").setDescription("เพิ่มสินค้าใหม่ (Admin Only)")
        .addStringOption(o => o.setName("id").setDescription("ID สินค้า (ภาษาอังกฤษ/ห้ามซ้ำ)").setRequired(true))
        .addStringOption(o => o.setName("name").setDescription("ชื่อสินค้า").setRequired(true))
        .addNumberOption(o => o.setName("price").setDescription("ราคาสินค้า").setRequired(true))
        .addStringOption(o => o.setName("description").setDescription("รายละเอียดสินค้า").setRequired(false)),
    new SlashCommandBuilder().setName("delete-product").setDescription("ลบสินค้าออกจากระบบ (Admin Only)")
        .addStringOption(o => o.setName("id").setDescription("ID สินค้าที่ต้องการลบ").setRequired(true)),
    new SlashCommandBuilder().setName("add-stock").setDescription("เพิ่มสต็อกสินค้า (Admin Only)")
        .addStringOption(o => o.setName("id").setDescription("ID สินค้า").setRequired(true))
        .addStringOption(o => o.setName("item").setDescription("ข้อมูลสินค้า/คีย์/โค้ด (คั่นด้วยจุลภาค , ถ้ามีหลายชิ้น)").setRequired(true)),
    new SlashCommandBuilder().setName("check-stock").setDescription("เช็กสต็อกสินค้าทั้งหมด (Admin Only)"),
    new SlashCommandBuilder().setName("manage-balance").setDescription("จัดการยอดเงินผู้ใช้ (Admin Only)")
        .addUserOption(o => o.setName("user").setDescription("ผู้ใช้งานที่ต้องการปรับยอด").setRequired(true))
        .addStringOption(o => o.setName("action").setDescription("การดำเนินการ").setRequired(true)
            .addChoices(
                { name: "เพิ่มเงิน (Add)", value: "add" },
                { name: "ลดเงิน (Remove)", value: "remove" },
                { name: "ตั้งค่ายอดเงิน (Set)", value: "set" }
            ))
        .addNumberOption(o => o.setName("amount").setDescription("จำนวนเงิน").setRequired(true)),
    new SlashCommandBuilder().setName("give-points").setDescription("แจกพอยต์/เงิน ให้ผู้ใช้โดยตรง (Admin Only)")
        .addUserOption(o => o.setName("user").setDescription("ผู้รับพอยต์").setRequired(true))
        .addNumberOption(o => o.setName("amount").setDescription("จำนวนพอยต์").setRequired(true)),
    new SlashCommandBuilder().setName("give-program").setDescription("แจกโปรแกรม/คีย์ สินค้าให้ผู้ใช้เข้า DM (Admin Only)")
        .addUserOption(o => o.setName("user").setDescription("ผู้รับสินค้า").setRequired(true))
        .addStringOption(o => o.setName("product_id").setDescription("ID สินค้าที่จะแจก").setRequired(true)),
    new SlashCommandBuilder().setName("check-user").setDescription("เช็กข้อมูลและยอดเงินของผู้ใช้ (Admin Only)")
        .addUserOption(o => o.setName("user").setDescription("เลือกผู้ใช้งาน").setRequired(true))
];

const rest = new REST({ version: "9" }).setToken(botToken);

client.once("ready", () => {
    (async () => {
        try {
            await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
            client.user.setActivity('Roblox', { type: ActivityType.Playing });
            console.log(chalk.green(`✅ เข้าสู่ระบบสำเร็จในชื่อ : ${client.user.tag}`));
            console.log(chalk.blue(`⚙️ ลงทะเบียนคำสั่ง Slash Commands เรียบร้อยแล้ว!`));
        } catch (err) {
            console.error(err);
        }
    })();
});

function createShopMenu() {
    const embed = new EmbedBuilder()
        .setTitle('🛒 LucaShop - เมนูบริการ')
        .setDescription(
            'ยินดีต้อนรับสู่ร้าน **LucaShop** กรุณาเลือกรายการที่ต้องการทำได้จากปุ่มด้านล่างครับ:

' +
            '• 🧧 **เติมเงินซอง TrueMoney:** เติมเงินอัตโนมัติผ่านลิงก์ซองอั่งเปา
' +
            '• 🏦 **เติมเงิน QR/ธนาคาร:** เติมเงินผ่านสแกน QR / สลิปโอนเงิน
' +
            '• 🛒 **เลือกซื้อสินค้า:** เลือกซื้อโปรแกรมและสินค้าของร้าน
' +
            '• 💳 **ดูยอดเงิน:** เช็กเงินคงเหลือในบัญชีของคุณ'
        )
        .setColor('Blue');
    
    if (config.imageUrl && config.imageUrl !== "") embed.setImage(config.imageUrl);

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('truemoney_topup').setLabel('🧧 เติมซอง TrueMoney').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('bank_topup_menu').setLabel('🏦 เติม QR/ธนาคาร').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('check_balance').setLabel('💳 ดูยอดเงินคงเหลือ').setStyle(ButtonStyle.Primary)
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('buy_menu').setLabel('🛒 เลือกซื้อสินค้า').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('list_products').setLabel('📦 ดูรายการสินค้าทั้งหมด').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('contact_admin').setLabel('📞 ติดต่อแอดมิน').setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [row1, row2] };
}

// ---------------------------------------------------------
// Control Room Menu (เหมือนเดิมตามรูป 100%)
// ---------------------------------------------------------
function createAdminControlMenu() {
    const embed = new EmbedBuilder()
        .setTitle('⚙️ แผงควบคุมระบบแอดมิน (Control Room)')
        .setDescription(
            'จัดการร้านค้าของคุณได้อย่างสะดวกรวดเร็ว:

' +
            '• ➕ **เพิ่มสินค้า:** สร้างสินค้าใหม่ ตั้งราคา และยศ
' +
            '• 🗑️ **ลบสินค้า:** นำสินค้าไม่ได้ขายออกจากระบบ
' +
            '• 📈 **เพิ่ม / 📉 ลดสต็อก:** จัดการจำนวนสินค้าเข้าออกคลัง
' +
            '• 📊 **เช็กสต็อกทั้งหมด:** ตรวจสอบสต็อกและยอดขายทั้งหมด
' +
            '• 💳 **จัดการเงิน / 🔍 เช็กข้อมูลผู้ใช้:** ตรวจสอบและจัดการลูกค้า
' +
            '• 🎉 **กิจกรรมแจก:** แจกโปรแกรมดาวน์โหลด หรือแจกพอยต์สะสม'
        )
        .setColor('#2b2d31');

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('btn_admin_add_product').setLabel('เพิ่มสินค้า').setEmoji('➕').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('btn_admin_delete_product').setLabel('ลบสินค้า').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('btn_admin_add_stock').setLabel('เพิ่มสต็อก').setEmoji('📈').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('btn_admin_remove_stock').setLabel('ลดสต็อก').setEmoji('📉').setStyle(ButtonStyle.Secondary)
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('btn_admin_check_stock').setLabel('เช็กระบบ/สต็อก').setEmoji('📊').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('btn_admin_manage_balance').setLabel('จัดการเงินผู้ใช้').setEmoji('💳').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('btn_admin_check_user').setLabel('เช็กผู้ใช้').setEmoji('🔍').setStyle(ButtonStyle.Secondary)
    );

    const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('btn_admin_give_item').setLabel('แจกโปรแกรม/ของ').setEmoji('🎁').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('btn_admin_give_points').setLabel('แจกพอยต์').setEmoji('💎').setStyle(ButtonStyle.Primary)
    );

    return { embeds: [embed], components: [row1, row2, row3] };
}

// ---------------------------------------------------------
// Process Slip Verification
// ---------------------------------------------------------
async function processSlipVerification(user, channel, attachment, topupId, interaction) {
    const topup = getTopups()[topupId];
    if (!topup) return;

    let verification;
    try {
        verification = await verifyBankSlipByUrl(attachment.url, topup.amount, topup.id);
    } catch (err) {
        console.error("EasySlip verification error:", err);
        return await interaction.followUp({
            embeds: [new EmbedBuilder()
                .setColor("Red")
                .setTitle("⚠️ ตรวจสอบสลิปไม่ผ่าน")
                .setDescription(`**สาเหตุ:** ${err.message || err}
กรุณาลองกดเติมเงินใหม่อีกครั้งครับ`)
            ],
            ephemeral: true
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

        return await interaction.followUp({
            embeds: [new EmbedBuilder()
                .setColor("Red")
                .setTitle("❌ สลิปไม่ผ่านการตรวจสอบ")
                .setDescription(
                    `🧾 รายการ: \`${topup.id}\`
` +
                    `💰 ยอดที่ต้องโอน: **${topup.amount.toFixed(2)} บาท**
` +
                    `💵 ยอดในสลิป: **${Number(verification.amount || 0).toFixed(2)} บาท**
` +
                    `📌 ยอดเงินตรง: ${amountMatched ? '✅' : '❌'}
` +
                    `🏦 บัญชีผู้รับตรง: ${accountMatched ? '✅' : '❌'}
` +
                    `♻️ สลิปซ้ำ: ${duplicate || localTransRefUsed ? '❌' : '✅'}`
                )
            ],
            ephemeral: true
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

    await interaction.followUp({
        embeds: [new EmbedBuilder()
            .setColor("Green")
            .setTitle("✅ เติมเงินสำเร็จ!")
            .setDescription(
                `🧾 **รหัสรายการ:** \`${topup.id}\`
` +
                `💰 **ยอดเงินที่ได้รับ:** **${topup.amount.toFixed(2)} บาท**
` +
                `💳 **ยอดเงินคงเหลือใหม่:** **${approved.balance.toFixed(2)} บาท**`
            )
        ],
        ephemeral: true
    });

    if (config.channellog) {
        const logChannel = channel.guild?.channels.cache.get(config.channellog);
        if (logChannel) {
            await logChannel.send({
                embeds: [new EmbedBuilder()
                    .setColor("Green")
                    .setTitle("🏦 เติมเงินสำเร็จ (Auto Verified)")
                    .setDescription(`👤 ผู้เติม: <@${topup.userId}>
🧾 รายการ: \`${topup.id}\`
💰 จำนวน: **${topup.amount.toFixed(2)} บาท**
💳 ยอดสะสม: **${approved.balance.toFixed(2)} บาท**`)
                    .setTimestamp()
                ]
            });
        }
    }
}

// ---------------------------------------------------------
// Main Interaction Handler
// ---------------------------------------------------------
client.on("interactionCreate", async (interaction) => {
    try {
        // --- 1. Slash Commands ---
        if (interaction.isChatInputCommand()) {
            if (!isAdmin(interaction)) {
                return interaction.reply({ content: "❌ คำสั่งนี้สำหรับ Admin เท่านั้นครับ", ephemeral: true });
            }

            const name = interaction.commandName;

            if (name === 'setup') return await interaction.reply(createShopMenu());
            if (name === 'setupadmincontrol') return await interaction.reply(createAdminControlMenu());

            if (name === 'give-points') {
                const targetUser = interaction.options.getUser('user');
                const amount = interaction.options.getNumber('amount');

                const balances = getBalances();
                if (!balances[targetUser.id]) balances[targetUser.id] = 0;
                balances[targetUser.id] += amount;
                saveBalances(balances);

                return interaction.reply({ content: `🎁 เติม/แจกพอยต์ให้ <@${targetUser.id}> จำนวน **${amount} พอยต์** เรียบร้อยแล้ว! (ยอดคงเหลือใหม่: **${balances[targetUser.id]} พอยต์**)`, ephemeral: true });
            }

            if (name === 'give-program') {
                const targetUser = interaction.options.getUser('user');
                const productId = interaction.options.getString('product_id');

                const products = getProducts();
                const product = products.find(p => p.id === productId);

                if (!product) return interaction.reply({ content: `❌ ไม่พบสินค้า ID \`${productId}\``, ephemeral: true });
                if (!Array.isArray(product.stock) || product.stock.length === 0) {
                    return interaction.reply({ content: `❌ สินค้า \`${product.name}\` หมดสต็อก ไม่สามารถแจกได้`, ephemeral: true });
                }

                const itemKey = product.stock.shift();
                saveProducts(products);

                try {
                    await targetUser.send({
                        embeds: [new EmbedBuilder()
                            .setColor("Gold")
                            .setTitle(`🎁 คุณได้รับของขวัญพิเศษ/โปรแกรมฟรี!`)
                            .setDescription(`🎉 แอดมินได้ส่งสินค้า **${product.name}** ให้แก่คุณ!

🔑 **ข้อมูลคีย์/สคริปต์ของคุณ:**
\`\`\`${itemKey}\`\`\``)
                        ]
                    });
                    return interaction.reply({ content: `✅ แจกสินค้า \`${product.name}\` ให้แก่ <@${targetUser.id}> ส่งเข้า DM เรียบร้อยแล้ว!`, ephemeral: true });
                } catch (e) {
                    return interaction.reply({ content: `⚠️ ตัดสต็อกเรียบร้อยแล้ว แต่ไม่สามารถส่ง DM หาผู้ใช้ได้ (เนื่องจากปิด DM): \`\`\`${itemKey}\`\`\``, ephemeral: true });
                }
            }

            if (name === 'add-product') {
                const id = interaction.options.getString('id');
                const pName = interaction.options.getString('name');
                const price = interaction.options.getNumber('price');
                const desc = interaction.options.getString('description') || 'ไม่มีรายละเอียด';

                const products = getProducts();
                if (products.some(p => p.id === id)) {
                    return interaction.reply({ content: `❌ มีสินค้า ID \`${id}\` อยู่ในระบบแล้ว`, ephemeral: true });
                }

                products.push({ id, name: pName, price, description: desc, stock: [] });
                saveProducts(products);

                return interaction.reply({ content: `✅ เพิ่มสินค้า \`${pName}\` (ID: ${id}) ราคา ${price} บาท เรียบร้อยแล้ว!`, ephemeral: true });
            }

            if (name === 'delete-product') {
                const id = interaction.options.getString('id');
                let products = getProducts();
                const initialLen = products.length;

                products = products.filter(p => p.id !== id);
                if (products.length === initialLen) {
                    return interaction.reply({ content: `❌ ไม่พบสินค้า ID \`${id}\``, ephemeral: true });
                }

                saveProducts(products);
                return interaction.reply({ content: `🗑️ ลบสินค้า ID \`${id}\` เรียบร้อยแล้ว`, ephemeral: true });
            }

            if (name === 'add-stock') {
                const id = interaction.options.getString('id');
                const rawItems = interaction.options.getString('item');
                const newItems = rawItems.split(',').map(s => s.trim()).filter(Boolean);

                const products = getProducts();
                const product = products.find(p => p.id === id);

                if (!product) return interaction.reply({ content: `❌ ไม่พบสินค้า ID \`${id}\``, ephemeral: true });

                if (!Array.isArray(product.stock)) product.stock = [];
                product.stock.push(...newItems);
                saveProducts(products);

                return interaction.reply({ content: `📦 เพิ่มสต็อกสินค้า \`${product.name}\` จำนวน **${newItems.length} ชิ้น** (รวมในคลัง: ${product.stock.length} ชิ้น)`, ephemeral: true });
            }

            if (name === 'check-stock') {
                const products = getProducts();
                if (products.length === 0) return interaction.reply({ content: "📦 ไม่พบสินค้าในระบบ", ephemeral: true });

                const embed = new EmbedBuilder().setTitle("📊 รายงานสต็อกสินค้าและระบบ").setColor("Blue");
                products.forEach(p => {
                    const count = Array.isArray(p.stock) ? p.stock.length : 0;
                    embed.addFields({ name: `📌 ${p.name} (ID: ${p.id})`, value: `💰 ราคา: ${p.price} บาท
📦 สินค้าคงเหลือ: **${count} ชิ้น**` });
                });

                return interaction.reply({ embeds: [embed], ephemeral: true });
            }

            if (name === 'manage-balance') {
                const targetUser = interaction.options.getUser('user');
                const action = interaction.options.getString('action');
                const amount = interaction.options.getNumber('amount');

                const balances = getBalances();
                let current = balances[targetUser.id] || 0;

                if (action === 'add') current += amount;
                else if (action === 'remove') current = Math.max(0, current - amount);
                else if (action === 'set') current = amount;

                balances[targetUser.id] = current;
                saveBalances(balances);

                return interaction.reply({ content: `💳 อัปเดตยอดเงินของ <@${targetUser.id}> เรียบร้อยแล้ว! ยอดเงินใหม่: **${current.toFixed(2)} บาท**`, ephemeral: true });
            }

            if (name === 'check-user') {
                const targetUser = interaction.options.getUser('user');
                const balances = getBalances();
                const balance = balances[targetUser.id] || 0;

                const embed = new EmbedBuilder()
                    .setTitle(`🔍 ข้อมูลผู้ใช้: ${targetUser.username}`)
                    .setThumbnail(targetUser.displayAvatarURL())
                    .setColor("Gold")
                    .addFields(
                        { name: "🆔 Discord ID", value: targetUser.id, inline: true },
                        { name: "💳 ยอดเงินคงเหลือ", value: `**${balance.toFixed(2)} บาท**`, inline: true }
                    );

                return interaction.reply({ embeds: [embed], ephemeral: true });
            }
        }

        // --- 2. Button Handlers ---
        if (interaction.isButton()) {

            // Handling Claims for Giveaways (ผู้ใช้กดรับของ / พอยต์)
            if (interaction.customId.startsWith('claim_giveaway_')) {
                const giveawayId = interaction.customId.replace('claim_giveaway_', '');
                const giveaways = getGiveaways();
                const gw = giveaways[giveawayId];

                if (!gw) {
                    return interaction.reply({ content: '❌ กิจกรรมนี้สิ้นสุดแล้วหรือถูกลบออกไปแล้ว', ephemeral: true });
                }

                if (!Array.isArray(gw.claimedUsers)) gw.claimedUsers = [];

                if (gw.claimedUsers.includes(interaction.user.id)) {
                    return interaction.reply({ content: '⚠️ คุณเคยรับสิทธิ์กิจกรรมนี้ไปแล้วครับ!', ephemeral: true });
                }

                if (gw.claimedUsers.length >= gw.limit) {
                    return interaction.reply({ content: '❌ เสียใจด้วยครับ สิทธิ์กิจกรรมนี้ถูกรับเต็มจำนวนแล้ว!', ephemeral: true });
                }

                // สิทธิ์ยังไม่เต็ม ดำเนินการแจก
                gw.claimedUsers.push(interaction.user.id);
                saveGiveaways(giveaways);

                // มอบยศ (ถ้าเป็นประเภทแจกของ และมีการกำหนด ID ยศไว้)
                if (gw.type === 'item' && gw.giveRoleId) {
                    try {
                        const role = interaction.guild.roles.cache.get(gw.giveRoleId);
                        if (role) await interaction.member.roles.add(role);
                    } catch (e) {
                        console.log('Cannot add role:', e);
                    }
                }

                // เติมพอยต์ (ถ้าเป็นประเภทแจกพอยต์)
                if (gw.type === 'points' && gw.pointsAmount > 0) {
                    const balances = getBalances();
                    if (!balances[interaction.user.id]) balances[interaction.user.id] = 0;
                    balances[interaction.user.id] += gw.pointsAmount;
                    saveBalances(balances);

                    await interaction.reply({
                        content: `🎉 **ยินดีด้วย!** คุณได้รับ **${gw.pointsAmount} พอยต์** เรียบร้อยแล้ว!
💳 ยอดเงินคงเหลือของคุณ: **${balances[interaction.user.id]} พอยต์**`,
                        ephemeral: true
                    });
                } else if (gw.type === 'item') {
                    let msg = `🎉 **ยินดีด้วย!** คุณได้รับของรางวัล **${gw.itemName}** เรียบร้อยแล้ว!`;
                    if (gw.downloadUrl) {
                        msg += `

📥 **ลิงก์ดาวน์โหลดโปรแกรม:**
${gw.downloadUrl}`;
                    }
                    await interaction.reply({ content: msg, ephemeral: true });
                }

                // อัปเดต Embed ข้อความกิจกรรมเพื่อโชว์จำนวนคนรับ
                try {
                    const embedMsg = interaction.message;
                    const oldEmbed = embedMsg.embeds[0];
                    if (oldEmbed) {
                        const newEmbed = EmbedBuilder.from(oldEmbed);
                        // อัปเดตข้อมูล footer หรือ field คนรับ
                        newEmbed.setFooter({ text: `ผู้รับสิทธิ์แล้ว: ${gw.claimedUsers.length}/${gw.limit} คน` });
                        await embedMsg.edit({ embeds: [newEmbed] });
                    }
                } catch (e) {}

                return;
            }

            // --- Admin Control Buttons ---
            if (interaction.customId.startsWith('btn_admin_')) {
                if (!isAdmin(interaction)) {
                    return interaction.reply({ content: "❌ เฉพาะ Admin เท่านั้นที่ใช้งานได้ครับ", ephemeral: true });
                }
            }

            if (interaction.customId === 'btn_admin_add_product') {
                const modal = new ModalBuilder().setCustomId('modal_admin_add_product').setTitle('➕ เพิ่มสินค้าใหม่');
                modal.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('p_id').setLabel('ID สินค้า (ภาษาอังกฤษ/ห้ามซ้ำ)').setStyle(TextInputStyle.Short).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('p_name').setLabel('ชื่อสินค้า').setStyle(TextInputStyle.Short).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('p_price').setLabel('ราคาสินค้า (บาท)').setStyle(TextInputStyle.Short).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('p_desc').setLabel('รายละเอียดสินค้า').setStyle(TextInputStyle.Paragraph).setRequired(false))
                );
                return await interaction.showModal(modal);
            }

            if (interaction.customId === 'btn_admin_delete_product') {
                const modal = new ModalBuilder().setCustomId('modal_admin_delete_product').setTitle('🗑️ ลบสินค้าออกจากระบบ');
                modal.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('p_id').setLabel('ID สินค้าที่ต้องการลบ').setStyle(TextInputStyle.Short).setRequired(true))
                );
                return await interaction.showModal(modal);
            }

            if (interaction.customId === 'btn_admin_add_stock') {
                const modal = new ModalBuilder().setCustomId('modal_admin_add_stock').setTitle('📈 เพิ่มสต็อกสินค้า');
                modal.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('p_id').setLabel('ID สินค้า').setStyle(TextInputStyle.Short).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('p_items').setLabel('คีย์/โค้ดสินค้า (คั่นด้วยจุลภาค ,)').setStyle(TextInputStyle.Paragraph).setRequired(true))
                );
                return await interaction.showModal(modal);
            }

            if (interaction.customId === 'btn_admin_remove_stock') {
                const modal = new ModalBuilder().setCustomId('modal_admin_remove_stock').setTitle('📉 ลด/ล้างสต็อกสินค้า');
                modal.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('p_id').setLabel('ID สินค้า').setStyle(TextInputStyle.Short).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('p_count').setLabel('จำนวนที่ต้องการลบ (หรือพิมพ์ all เพื่อล้าง)').setStyle(TextInputStyle.Short).setRequired(true))
                );
                return await interaction.showModal(modal);
            }

            if (interaction.customId === 'btn_admin_check_stock') {
                const products = getProducts();
                if (products.length === 0) return interaction.reply({ content: "📦 ไม่พบสินค้าในระบบ", ephemeral: true });

                const embed = new EmbedBuilder().setTitle("📊 รายงานสต็อกสินค้าทั้งหมด").setColor("Blue");
                products.forEach(p => {
                    const count = Array.isArray(p.stock) ? p.stock.length : 0;
                    embed.addFields({ name: `📌 ${p.name} (ID: ${p.id})`, value: `💰 ราคา: ${p.price} บาท | 📦 สต็อกคงเหลือ: **${count} ชิ้น**` });
                });
                return interaction.reply({ embeds: [embed], ephemeral: true });
            }

            if (interaction.customId === 'btn_admin_manage_balance') {
                const modal = new ModalBuilder().setCustomId('modal_admin_manage_balance').setTitle('💳 จัดการยอดเงินผู้ใช้');
                modal.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('u_id').setLabel('Discord User ID ผู้ใช้').setStyle(TextInputStyle.Short).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('u_action').setLabel('การดำเนินการ (add / remove / set)').setPlaceholder('add = เพิ่ม, remove = ลด, set = ตั้งค่า').setStyle(TextInputStyle.Short).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('u_amount').setLabel('จำนวนเงิน (พอยต์)').setStyle(TextInputStyle.Short).setRequired(true))
                );
                return await interaction.showModal(modal);
            }

            if (interaction.customId === 'btn_admin_check_user') {
                const modal = new ModalBuilder().setCustomId('modal_admin_check_user').setTitle('🔍 เช็กข้อมูลผู้ใช้');
                modal.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('u_id').setLabel('Discord User ID ผู้ใช้').setStyle(TextInputStyle.Short).setRequired(true))
                );
                return await interaction.showModal(modal);
            }

            // ปุ่มแอดมิน: แจกของ/โปรแกรม
            if (interaction.customId === 'btn_admin_give_item') {
                const modal = new ModalBuilder().setCustomId('modal_admin_give_item').setTitle('🎁 กิจกรรมแจกโปรแกรม / ของ');
                modal.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('g_channel').setLabel('ID ห้องที่จะแจก').setPlaceholder('เช่น 123456789012345678').setStyle(TextInputStyle.Short).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('g_title').setLabel('หัวข้อกิจกรรม').setPlaceholder('เช่น แจกฟรี โปรแกรม VIP LucaShop').setStyle(TextInputStyle.Short).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('g_name').setLabel('ชื่อของที่จะแจก / รายละเอียดกิจกรรม').setPlaceholder('ใส่ชื่อของ และรายละเอียดกติกา').setStyle(TextInputStyle.Paragraph).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('g_download').setLabel('ลิงก์ดาวน์โหลดโปรแกรม').setPlaceholder('https://... (เว้นว่างได้)').setStyle(TextInputStyle.Short).setRequired(false)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('g_more').setLabel('จำนวนคนรับ / ยศรับ / ยศแท็ก / รูปภาพ').setPlaceholder('รูปแบบ: ลิมิตคน|IDยศที่จะแจก|ยศแท็ก|URLรูป').setStyle(TextInputStyle.Short).setRequired(true))
                );
                return await interaction.showModal(modal);
            }

            // ปุ่มแอดมิน: แจกพอยต์
            if (interaction.customId === 'btn_admin_give_points') {
                const modal = new ModalBuilder().setCustomId('modal_admin_give_points').setTitle('💎 กิจกรรมแจกพอยต์');
                modal.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('p_channel').setLabel('ID ห้องที่จะแจก').setPlaceholder('เช่น 123456789012345678').setStyle(TextInputStyle.Short).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('p_title').setLabel('หัวข้อกิจกรรม').setPlaceholder('เช่น กิจกรรมแจกพอยต์ฟรี 50 พอยต์').setStyle(TextInputStyle.Short).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('p_desc').setLabel('รายละเอียดกิจกรรม').setPlaceholder('รายละเอียดกติกา').setStyle(TextInputStyle.Paragraph).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('p_amount').setLabel('จำนวนพอยต์ต่อคน').setPlaceholder('เช่น 50').setStyle(TextInputStyle.Short).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('p_more').setLabel('จำนวนคนรับ / ยศแท็ก / ลิงก์รูปภาพ').setPlaceholder('รูปแบบ: ลิมิตคน|ยศแท็ก|URLรูปภาพ (เช่น 10|@everyone|https://...)').setStyle(TextInputStyle.Short).setRequired(true))
                );
                return await interaction.showModal(modal);
            }

            // --- Client Buttons ---
            if (interaction.customId === "truemoney_topup") {
                const modal = new ModalBuilder().setCustomId('truemoney_modal').setTitle('🧧 เติมเงินซอง TrueMoney');
                const voucherInput = new TextInputBuilder().setCustomId('voucher_url').setLabel("ลิงก์ซองอั่งเปา TrueMoney").setPlaceholder("https://gift.truemoney.com/v voucher/...").setStyle(TextInputStyle.Short).setRequired(true);
                modal.addComponents(new ActionRowBuilder().addComponents(voucherInput));
                return await interaction.showModal(modal);
            }

            if (interaction.customId === "check_balance") {
                const balances = getBalances();
                return await interaction.reply({ embeds: [new EmbedBuilder().setColor("Blurple").setTitle("💳 ยอดเงินคงเหลือ").setDescription(`💰 คุณมียอดเงินสะสม: **${balances[interaction.user.id] || 0} บาท**`)], ephemeral: true });
            }

            if (interaction.customId === "list_products") {
                const products = getProducts();
                if (products.length === 0) return interaction.reply({ content: "📦 ขณะนี้ยังไม่มีสินค้าในร้านครับ", ephemeral: true });

                let desc = products.map((p, i) => `${i + 1}. **${p.name}** (ID: \`${p.id}\`) - ราคา **${p.price} บาท** (คงเหลือ: ${Array.isArray(p.stock) ? p.stock.length : 0} ชิ้น)`).join('
');
                return interaction.reply({ embeds: [new EmbedBuilder().setColor("Blue").setTitle("📦 รายการสินค้าทั้งหมด").setDescription(desc)], ephemeral: true });
            }

            if (interaction.customId === "buy_menu") {
                const products = getProducts();
                if (products.length === 0) return interaction.reply({ content: "❌ ไม่มีสินค้าพร้อมขายในขณะนี้", ephemeral: true });

                const selectMenu = new StringSelectMenuBuilder()
                    .setCustomId('select_product_buy')
                    .setPlaceholder('🛒 เลือกสินค้าที่คุณต้องการซื้อ...')
                    .addOptions(products.map(p => ({
                        label: p.name,
                        description: `ราคา ${p.price} บาท (คงเหลือ: ${Array.isArray(p.stock) ? p.stock.length : 0} ชิ้น)`,
                        value: p.id
                    })));

                return interaction.reply({
                    embeds: [new EmbedBuilder().setColor("Yellow").setTitle("🛒 เลือกสินค้าที่ต้องการซื้อ").setDescription("เลือกรายการสินค้าจากเมนูด้านล่างนี้ได้เลยครับ:")],
                    components: [new ActionRowBuilder().addComponents(selectMenu)],
                    ephemeral: true
                });
            }

            if (interaction.customId === "contact_admin") {
                return interaction.reply({ content: `📞 หากต้องการความช่วยเหลือ สามารถติดต่อแอดมินได้เลยครับ: <@${config.ownerIDs ? config.ownerIDs[0] : config.ownerID}>`, ephemeral: true });
            }

            if (interaction.customId.startsWith('upload_slip_')) {
                const topupId = interaction.customId.replace('upload_slip_', '');
                const topup = getTopups()[topupId];

                if (!topup || topup.status === 'expired' || topup.status === 'cancelled') {
                    return interaction.reply({ content: "❌ รายการนี้หมดอายุหรือถูกยกเลิกไปแล้ว กรุณากดเติมเงินใหม่ครับ", ephemeral: true });
                }

                awaitingSlipUsers.set(interaction.user.id, {
                    topupId: topupId,
                    channelId: interaction.channelId,
                    interaction: interaction,
                    expiresAt: Date.now() + (5 * 60 * 1000)
                });

                return await interaction.reply({
                    content: `📥 **กรุณาส่ง/แนบรูปภาพสลิปของคุณลงในช่องแชทนี้ได้เลยครับ!**
*(ระบบกำลังรอรับรูปสลิปจากคุณเป็นเวลา 5 นาที...)*`,
                    ephemeral: true
                });
            }

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
                try { await interaction.message.delete(); } catch(e) {}
                return await interaction.reply({ content: `🗑️ ยกเลิกรายการ \`${topupId}\` เรียบร้อยแล้ว`, ephemeral: true });
            }

            if (interaction.customId === "bank_topup_menu") {
                const topups = getTopups();
                const now = Date.now();
                const timeoutMs = BANK_TOPUP_TIMEOUT_MINUTES * 60 * 1000;

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
                            .setDescription(`🧾 รหัสรายการ: \`${existing.id}\`
💰 ยอดที่ต้องโอน: **${existing.amount.toFixed(2)} บาท**`)
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
        }

        // --- 3. String Select Menu ---
        if (interaction.isStringSelectMenu()) {
            if (interaction.customId === 'select_product_buy') {
                const productId = interaction.values[0];
                const products = getProducts();
                const product = products.find(p => p.id === productId);

                if (!product) return interaction.reply({ content: "❌ ไม่พบสินค้านี้ในระบบ", ephemeral: true });

                const balances = getBalances();
                const userBalance = balances[interaction.user.id] || 0;

                if (userBalance < product.price) {
                    return interaction.reply({ content: `❌ ยอดเงินของคุณไม่พอ! สินค้า 💰 **${product.price} บาท** (ยอดเงินคุณ: **${userBalance} บาท**)`, ephemeral: true });
                }

                if (!Array.isArray(product.stock) || product.stock.length === 0) {
                    return interaction.reply({ content: "❌ สินค้ารายการนี้หมดสต็อกชั่วคราวครับ", ephemeral: true });
                }

                const itemReceived = product.stock.shift();
                balances[interaction.user.id] -= product.price;

                saveProducts(products);
                saveBalances(balances);

                return interaction.reply({
                    embeds: [new EmbedBuilder()
                        .setColor("Green")
                        .setTitle("🎉 สั่งซื้อสินค้าสำเร็จ!")
                        .setDescription(`📦 **สินค้า:** ${product.name}
💰 **ราคา:** ${product.price} บาท
💳 **เงินคงเหลือ:** ${balances[interaction.user.id]} บาท

🔑 **ข้อมูลสินค้า/คีย์ของคุณ:**
\`\`\`${itemReceived}\`\`\``)
                    ],
                    ephemeral: true
                });
            }
        }

        // --- 4. Modal Submits ---
        if (interaction.isModalSubmit()) {

            // Admin Modal Submit Handlers
            if (interaction.customId === 'modal_admin_add_product') {
                const id = interaction.fields.getTextInputValue('p_id').trim();
                const name = interaction.fields.getTextInputValue('p_name').trim();
                const price = Number(interaction.fields.getTextInputValue('p_price').trim());
                const desc = interaction.fields.getTextInputValue('p_desc') || 'ไม่มีรายละเอียด';

                const products = getProducts();
                if (products.some(p => p.id === id)) return interaction.reply({ content: `❌ มีสินค้า ID \`${id}\` แล้ว`, ephemeral: true });

                products.push({ id, name, price, description: desc, stock: [] });
                saveProducts(products);
                return interaction.reply({ content: `✅ เพิ่มสินค้า \`${name}\` (ID: ${id}) ราคา ${price} บาท เรียบร้อยแล้ว!`, ephemeral: true });
            }

            if (interaction.customId === 'modal_admin_delete_product') {
                const id = interaction.fields.getTextInputValue('p_id').trim();
                let products = getProducts();
                const initLen = products.length;
                products = products.filter(p => p.id !== id);
                if (products.length === initLen) return interaction.reply({ content: `❌ ไม่พบสินค้า ID \`${id}\``, ephemeral: true });
                saveProducts(products);
                return interaction.reply({ content: `🗑️ ลบสินค้า ID \`${id}\` เรียบร้อยแล้ว`, ephemeral: true });
            }

            if (interaction.customId === 'modal_admin_add_stock') {
                const id = interaction.fields.getTextInputValue('p_id').trim();
                const items = interaction.fields.getTextInputValue('p_items').split(',').map(s => s.trim()).filter(Boolean);
                const products = getProducts();
                const p = products.find(x => x.id === id);
                if (!p) return interaction.reply({ content: `❌ ไม่พบสินค้า ID \`${id}\``, ephemeral: true });
                if (!Array.isArray(p.stock)) p.stock = [];
                p.stock.push(...items);
                saveProducts(products);
                return interaction.reply({ content: `📈 เพิ่มสต็อกสินค้า \`${p.name}\` จำนวน ${items.length} ชิ้น (รวมในคลัง: ${p.stock.length} ชิ้น)`, ephemeral: true });
            }

            if (interaction.customId === 'modal_admin_remove_stock') {
                const id = interaction.fields.getTextInputValue('p_id').trim();
                const countVal = interaction.fields.getTextInputValue('p_count').trim();
                const products = getProducts();
                const p = products.find(x => x.id === id);
                if (!p) return interaction.reply({ content: `❌ ไม่พบสินค้า ID \`${id}\``, ephemeral: true });

                if (countVal.toLowerCase() === 'all') {
                    p.stock = [];
                } else {
                    const c = parseInt(countVal) || 0;
                    p.stock.splice(0, c);
                }
                saveProducts(products);
                return interaction.reply({ content: `📉 ปรับลดสต็อกสินค้า \`${p.name}\` เรียบร้อยแล้ว (คงเหลือ: ${p.stock.length} ชิ้น)`, ephemeral: true });
            }

            if (interaction.customId === 'modal_admin_manage_balance') {
                const userId = interaction.fields.getTextInputValue('u_id').trim();
                const action = interaction.fields.getTextInputValue('u_action').trim().toLowerCase();
                const amount = Number(interaction.fields.getTextInputValue('u_amount').trim());

                const balances = getBalances();
                let cur = balances[userId] || 0;
                if (action === 'add') cur += amount;
                else if (action === 'remove') cur = Math.max(0, cur - amount);
                else if (action === 'set') cur = amount;

                balances[userId] = cur;
                saveBalances(balances);
                return interaction.reply({ content: `💳 อัปเดตยอดเงินของผู้ใช้ <@${userId}> เป็น **${cur.toFixed(2)} บาท** เรียบร้อย!`, ephemeral: true });
            }

            if (interaction.customId === 'modal_admin_check_user') {
                const userId = interaction.fields.getTextInputValue('u_id').trim();
                const balances = getBalances();
                const bal = balances[userId] || 0;
                return interaction.reply({ content: `🔍 **ข้อมูลผู้ใช้ ID:** \`${userId}\`
💳 ยอดเงินคงเหลือ: **${bal.toFixed(2)} บาท**`, ephemeral: true });
            }

            // Modal แจกโปรแกรม / ของ
            if (interaction.customId === 'modal_admin_give_item') {
                const channelId = interaction.fields.getTextInputValue('g_channel').trim();
                const title = interaction.fields.getTextInputValue('g_title').trim();
                const nameAndDesc = interaction.fields.getTextInputValue('g_name').trim();
                const downloadUrl = interaction.fields.getTextInputValue('g_download') || '';
                const moreOpts = interaction.fields.getTextInputValue('g_more').trim();

                const targetChannel = interaction.guild.channels.cache.get(channelId);
                if (!targetChannel) return interaction.reply({ content: `❌ ไม่พบห้อง ID \`${channelId}\` ในเซิร์ฟเวอร์นี้`, ephemeral: true });

                // แปลง options: ลิมิตคน|IDยศที่จะแจก|ยศแท็ก|URLรูป
                const parts = moreOpts.split('|').map(s => s.trim());
                const limit = parseInt(parts[0]) || 1;
                const giveRoleId = parts[1] || '';
                const roleMention = parts[2] || '';
                const imageUrl = parts[3] || '';

                const giveawayId = `GW-ITEM-${Date.now()}`;
                const giveaways = getGiveaways();
                giveaways[giveawayId] = {
                    id: giveawayId,
                    type: 'item',
                    itemName: title,
                    downloadUrl,
                    limit,
                    giveRoleId,
                    claimedUsers: [],
                    createdAt: new Date().toISOString()
                };
                saveGiveaways(giveaways);

                const embed = new EmbedBuilder()
                    .setTitle(`🎁 กิจกรรมแจกโปรแกรม/ของ: ${title}`)
                    .setDescription(`${nameAndDesc}

👥 **จำนวนสิทธิ์:** จำกัด ${limit} คนเท่านั้น!`)
                    .setColor('Gold')
                    .setFooter({ text: `ผู้รับสิทธิ์แล้ว: 0/${limit} คน` })
                    .setTimestamp();

                if (imageUrl && imageUrl.startsWith('http')) embed.setImage(imageUrl);

                let contentMsg = '';
                if (roleMention) {
                    if (roleMention === '@everyone' || roleMention === '@here') contentMsg = roleMention;
                    else contentMsg = `<@&${roleMention.replace(/[^0-9]/g, '')}>`;
                }

                const claimBtn = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`claim_giveaway_${giveawayId}`).setLabel('🎉 กดรับของรางวัล').setStyle(ButtonStyle.Success)
                );

                if (downloadUrl && downloadUrl.startsWith('http')) {
                    claimBtn.addComponents(
                        new ButtonBuilder().setLabel('📥 ลิงก์ดาวน์โหลด').setStyle(ButtonStyle.Link).setURL(downloadUrl)
                    );
                }

                await targetChannel.send({ content: contentMsg || undefined, embeds: [embed], components: [claimBtn] });
                return interaction.reply({ content: `✅ สร้างกิจกรรมแจกของในห้อง <#${channelId}> เรียบร้อยแล้ว!`, ephemeral: true });
            }

            // Modal แจกพอยต์
            if (interaction.customId === 'modal_admin_give_points') {
                const channelId = interaction.fields.getTextInputValue('p_channel').trim();
                const title = interaction.fields.getTextInputValue('p_title').trim();
                const desc = interaction.fields.getTextInputValue('p_desc').trim();
                const amount = Number(interaction.fields.getTextInputValue('p_amount').trim());
                const moreOpts = interaction.fields.getTextInputValue('p_more').trim();

                const targetChannel = interaction.guild.channels.cache.get(channelId);
                if (!targetChannel) return interaction.reply({ content: `❌ ไม่พบห้อง ID \`${channelId}\` ในเซิร์ฟเวอร์นี้`, ephemeral: true });

                // แปลง options: ลิมิตคน|ยศแท็ก|URLรูปภาพ
                const parts = moreOpts.split('|').map(s => s.trim());
                const limit = parseInt(parts[0]) || 1;
                const roleMention = parts[1] || '';
                const imageUrl = parts[2] || '';

                const giveawayId = `GW-POINTS-${Date.now()}`;
                const giveaways = getGiveaways();
                giveaways[giveawayId] = {
                    id: giveawayId,
                    type: 'points',
                    pointsAmount: amount,
                    limit,
                    claimedUsers: [],
                    createdAt: new Date().toISOString()
                };
                saveGiveaways(giveaways);

                const embed = new EmbedBuilder()
                    .setTitle(`💎 กิจกรรมแจกพอยต์: ${title}`)
                    .setDescription(`${desc}

💰 **แจกพอยต์:** **${amount} พอยต์/คน**
👥 **จำนวนสิทธิ์:** จำกัด ${limit} คนเท่านั้น!`)
                    .setColor('Blue')
                    .setFooter({ text: `ผู้รับสิทธิ์แล้ว: 0/${limit} คน` })
                    .setTimestamp();

                if (imageUrl && imageUrl.startsWith('http')) embed.setImage(imageUrl);

                let contentMsg = '';
                if (roleMention) {
                    if (roleMention === '@everyone' || roleMention === '@here') contentMsg = roleMention;
                    else contentMsg = `<@&${roleMention.replace(/[^0-9]/g, '')}>`;
                }

                const claimBtn = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`claim_giveaway_${giveawayId}`).setLabel('💎 กดรับพอยต์').setStyle(ButtonStyle.Primary)
                );

                await targetChannel.send({ content: contentMsg || undefined, embeds: [embed], components: [claimBtn] });
                return interaction.reply({ content: `✅ สร้างกิจกรรมแจกพอยต์ในห้อง <#${channelId}> เรียบร้อยแล้ว!`, ephemeral: true });
            }

            // Client Modals
            if (interaction.customId === "truemoney_modal") {
                const voucherUrl = interaction.fields.getTextInputValue('voucher_url');
                const phone = config.phone;

                if (!phone) return interaction.reply({ content: "❌ แอดมินยังไม่ได้ตั้งเบอร์โทรศัพท์ใน config.json", ephemeral: true });

                tw(phone, voucherUrl).then(res => {
                    const amount = Number(res.amount);
                    const balances = getBalances();
                    if (!balances[interaction.user.id]) balances[interaction.user.id] = 0;
                    balances[interaction.user.id] += amount;
                    saveBalances(balances);

                    interaction.reply({ embeds: [new EmbedBuilder().setColor("Green").setTitle("✅ เติมเงินสำเร็จ (TrueMoney)").setDescription(`💰 จำนวน: **${amount} บาท**
💳 ยอดคงเหลือใหม่: **${balances[interaction.user.id]} บาท**`)], ephemeral: true });

                    if (config.channellog) {
                        const logChannel = interaction.guild.channels.cache.get(config.channellog);
                        if (logChannel) logChannel.send({ embeds: [new EmbedBuilder().setColor("Green").setTitle("🧧 เติมเงินสำเร็จ (TrueMoney)").setDescription(`👤 ผู้เติม: <@${interaction.user.id}>
💰 จำนวน: **${amount} บาท**`)] });
                    }
                }).catch(err => {
                    interaction.reply({ content: `❌ เกิดข้อผิดพลาด: ลิงก์ซองไม่ถูกต้อง หรือถูกใช้งานไปแล้ว`, ephemeral: true });
                });
            }

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
                        `🧾 **รหัสรายการ:** \`${topupId}\`
` +
                        `💰 **ยอดที่ต้องโอน:** **${amount.toFixed(2)} บาท**
` +
                        `⏰ **หมดอายุใน:** <t:${expireUnix}:R>

` +
                        `${getBankTopupDescription()}

` +
                        `📌 **ขั้นตอนการยืนยัน:**
` +
                        `1. โอนเงินตามยอดด้านบน
` +
                        `2. โอนเสร็จแล้ว ให้กดปุ่ม **"📸 แนบรูปสลิปยืนยัน"** ด้านล่าง
` +
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

// Listener for Slip Attachments
client.on('messageCreate', async (message) => {
    try {
        if (message.author.bot) return;

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

        message.delete().catch(() => {});

        if (pending.interaction && pending.interaction.message) {
            pending.interaction.message.delete().catch(() => {});
        }

        awaitingSlipUsers.delete(message.author.id);

        await processSlipVerification(message.author, message.channel, attachment, pending.topupId, pending.interaction);

    } catch (err) {
        console.error("Auto slip handler error:", err);
    }
});

process.on('unhandledRejection', (reason) => console.log(' [Anti-Crash] :: Unhandled Rejection', reason));
process.on('uncaughtException', (err) => console.log(' [Anti-Crash] :: Uncaught Exception', err));

client.login(botToken);
