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
    UserSelectMenuBuilder,
    ChannelSelectMenuBuilder,
    ChannelType,
    ActivityType, 
    AttachmentBuilder,
    SlashCommandBuilder
} = require('discord.js');

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
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
const tempAdminData = new Map(); // เก็บสถานะชั่วคราวของการเลือกห้อง/ผู้ใช้

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
// Helper: Smart Parse Extra Options (รูปภาพ / ยศ / ลิมิต)
// ---------------------------------------------------------
function parseGiveawayMoreOptions(str) {
    const parts = str.split('|').map(s => s.trim());
    let limit = 1;
    let giveRoleId = '';
    let roleMention = '';
    let imageUrl = '';

    parts.forEach((p, index) => {
        if (index === 0 && /^\d+$/.test(p)) {
            limit = parseInt(p);
        } else if (p.startsWith('http://') || p.startsWith('https://')) {
            imageUrl = p;
        } else if (p === '@everyone' || p === '@here' || p.startsWith('<@&')) {
            roleMention = p;
        } else if (/^\d{17,20}$/.test(p)) {
            if (!giveRoleId) giveRoleId = p;
            else if (!roleMention) roleMention = `<@&${p}>`;
        }
    });

    return { limit, giveRoleId, roleMention, imageUrl };
}

// ---------------------------------------------------------
// Slash Commands Definition
// ---------------------------------------------------------
const commands = [
    new SlashCommandBuilder().setName("setup").setDescription("ติดตั้งหน้าต่างเมนูร้านค้าสำหรับลูกค้า (Admin Only)"),
    new SlashCommandBuilder().setName("setupadmincontrol").setDescription("ติดตั้งแผงควบคุมระบบสำหรับแอดมิน (Control Room)")
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
            'ยินดีต้อนรับสู่ร้าน **LucaShop** กรุณาเลือกรายการที่ต้องการทำได้จากปุ่มด้านล่างครับ:\n\n' +
            '• 🧧 **เติมเงินซอง TrueMoney:** เติมเงินอัตโนมัติผ่านลิงก์ซองอั่งเปา\n' +
            '• 🏦 **เติมเงิน QR/ธนาคาร:** เติมเงินผ่านสแกน QR / สลิปโอนเงิน\n' +
            '• 🛒 **เลือกซื้อสินค้า:** เลือกซื้อโปรแกรมและสินค้าของร้าน\n' +
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

function createAdminControlMenu() {
    const embed = new EmbedBuilder()
        .setTitle('⚙️ แผงควบคุมระบบแอดมิน (Control Room)')
        .setDescription(
            'จัดการร้านค้าของคุณได้อย่างสะดวกรวดเร็ว:\n\n' +
            '• ➕ **เพิ่มสินค้า:** สร้างสินค้าใหม่ ตั้งราคา ยศ และลิงก์โหลด\n' +
            '• 🗑️ **ลบสินค้า:** นำสินค้าไม่ได้ขายออกจากระบบ\n' +
            '• 📈 **เพิ่มสต็อก:** เลือกสินค้าจากเมนู แล้วกรอกจำนวนชิ้นได้ทันที\n' +
            '• 📊 **เช็กสต็อกทั้งหมด:** ตรวจสอบสต็อกและยอดขายทั้งหมด\n' +
            '• 💳 **จัดการเงินผู้ใช้:** เลือกผู้ใช้จากเมนูดรอปดาวน์ และปรับเงิน\n' +
            '• 🎉 **กิจกรรมแจก:** เลือกห้องจากเมนูดรอปดาวน์ได้ทันที'
        )
        .setColor('#2b2d31');

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('btn_admin_add_product').setLabel('เพิ่มสินค้า').setEmoji('➕').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('btn_admin_delete_product').setLabel('ลบสินค้า').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('btn_admin_add_stock').setLabel('เพิ่มสต็อก').setEmoji('📈').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('btn_admin_remove_stock').setLabel('ลด/ล้างสต็อก').setEmoji('📉').setStyle(ButtonStyle.Secondary)
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
                .setDescription(`**สาเหตุ:** ${err.message || err}\nกรุณาลองกดเติมเงินใหม่อีกครั้งครับ`)
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
                    `🧾 รายการ: \`${topup.id}\`\n` +
                    `💰 ยอดที่ต้องโอน: **${topup.amount.toFixed(2)} บาท**\n` +
                    `💵 ยอดในสลิป: **${Number(verification.amount || 0).toFixed(2)} บาท**\n` +
                    `📌 ยอดเงินตรง: ${amountMatched ? '✅' : '❌'}\n` +
                    `🏦 บัญชีผู้รับตรง: ${accountMatched ? '✅' : '❌'}\n` +
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
                `🧾 **รหัสรายการ:** \`${topup.id}\`\n` +
                `💰 **ยอดเงินที่ได้รับ:** **${topup.amount.toFixed(2)} บาท**\n` +
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
                    .setDescription(`👤 ผู้เติม: <@${topup.userId}>\n🧾 รายการ: \`${topup.id}\`\n💰 จำนวน: **${topup.amount.toFixed(2)} บาท**\n💳 ยอดสะสม: **${approved.balance.toFixed(2)} บาท**`)
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
        }

        // --- 2. Button Handlers ---
        if (interaction.isButton()) {

            // Handling Claims for Giveaways (กดรับของรางวัล)
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

                gw.claimedUsers.push(interaction.user.id);
                saveGiveaways(giveaways);

                // มอบยศหากตั้งค่าไว้
                if (gw.giveRoleId) {
                    try {
                        const role = interaction.guild.roles.cache.get(gw.giveRoleId);
                        if (role) await interaction.member.roles.add(role);
                    } catch (e) {
                        console.log('Cannot add role:', e);
                    }
                }

                if (gw.type === 'points' && gw.pointsAmount > 0) {
                    const balances = getBalances();
                    if (!balances[interaction.user.id]) balances[interaction.user.id] = 0;
                    balances[interaction.user.id] += gw.pointsAmount;
                    saveBalances(balances);

                    await interaction.reply({
                        content: `🎉 **ยินดีด้วย!** คุณได้รับ **${gw.pointsAmount} พอยต์** เรียบร้อยแล้ว!\n💳 ยอดเงินคงเหลือของคุณ: **${balances[interaction.user.id]} พอยต์**`,
                        ephemeral: true
                    });
                } else if (gw.type === 'item') {
                    let msg = `🎉 **ยินดีด้วย!** คุณได้รับของรางวัล **${gw.itemName}** เรียบร้อยแล้ว!`;
                    if (gw.downloadUrl && gw.downloadUrl.startsWith('http')) {
                        msg += `\n\n📥 **ลิงก์ดาวน์โหลดโปรแกรมของคุณ:**\n${gw.downloadUrl}`;
                    }
                    await interaction.reply({ content: msg, ephemeral: true });
                }

                // อัปเดตจำนวนผู้รับสิทธิ์ใน Embed
                try {
                    const embedMsg = interaction.message;
                    const oldEmbed = embedMsg.embeds[0];
                    if (oldEmbed) {
                        const newEmbed = EmbedBuilder.from(oldEmbed);
                        newEmbed.setFooter({ text: `ผู้รับสิทธิ์แล้ว: ${gw.claimedUsers.length}/${gw.limit} คน` });
                        await embedMsg.edit({ embeds: [newEmbed] });
                    }
                } catch (e) {}

                return;
            }

            // --- Admin Control Buttons Check ---
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
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('p_download').setLabel('ลิงก์ดาวน์โหลดสินค้า (เว้นว่างได้)').setStyle(TextInputStyle.Short).setRequired(false)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('p_role').setLabel('ID ยศที่จะได้รับเมื่อซื้อ (เว้นว่างได้)').setStyle(TextInputStyle.Short).setRequired(false))
                );
                return await interaction.showModal(modal);
            }

            if (interaction.customId === 'btn_admin_delete_product') {
                const products = getProducts();
                if (products.length === 0) return interaction.reply({ content: "📦 ไม่มีสินค้าในระบบให้ลบ", ephemeral: true });

                const selectMenu = new StringSelectMenuBuilder()
                    .setCustomId('select_admin_delete_product')
                    .setPlaceholder('🗑️ เลือกสินค้าที่ต้องการลบ...')
                    .addOptions(products.map(p => ({ label: p.name, description: `ID: ${p.id} | ราคา ${p.price} บาท`, value: p.id })));

                return interaction.reply({
                    content: "📌 **กรุณาเลือกสินค้าที่ต้องการลบออกจากระบบ:**",
                    components: [new ActionRowBuilder().addComponents(selectMenu)],
                    ephemeral: true
                });
            }

            if (interaction.customId === 'btn_admin_add_stock') {
                const products = getProducts();
                if (products.length === 0) return interaction.reply({ content: "📦 ไม่มีสินค้าในระบบ กรุณาเพิ่มสินค้าก่อน", ephemeral: true });

                const selectMenu = new StringSelectMenuBuilder()
                    .setCustomId('select_admin_add_stock')
                    .setPlaceholder('📈 เลือกสินค้าที่ต้องการเติมสต็อก...')
                    .addOptions(products.map(p => ({
                        label: p.name,
                        description: `ID: ${p.id} | คงเหลือปัจจุบัน: ${Array.isArray(p.stock) ? p.stock.length : 0} ชิ้น`,
                        value: p.id
                    })));

                return interaction.reply({
                    content: "📌 **เลือกสินค้าที่ต้องการเพิ่มสต็อก (สิทธิ์การซื้อ):**",
                    components: [new ActionRowBuilder().addComponents(selectMenu)],
                    ephemeral: true
                });
            }

            if (interaction.customId === 'btn_admin_remove_stock') {
                const products = getProducts();
                if (products.length === 0) return interaction.reply({ content: "📦 ไม่มีสินค้าในระบบ", ephemeral: true });

                const selectMenu = new StringSelectMenuBuilder()
                    .setCustomId('select_admin_remove_stock')
                    .setPlaceholder('📉 เลือกสินค้าที่ต้องการล้าง/ลดสต็อก...')
                    .addOptions(products.map(p => ({ label: p.name, description: `ID: ${p.id} | คงเหลือ: ${Array.isArray(p.stock) ? p.stock.length : 0} ชิ้น`, value: p.id })));

                return interaction.reply({
                    content: "📌 **เลือกสินค้าที่ต้องการล้างสต็อกทั้งหมด:**",
                    components: [new ActionRowBuilder().addComponents(selectMenu)],
                    ephemeral: true
                });
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

            // เลือกผู้ใช้ผ่าน UserSelectMenu
            if (interaction.customId === 'btn_admin_manage_balance') {
                const userSelect = new UserSelectMenuBuilder()
                    .setCustomId('select_admin_balance_user')
                    .setPlaceholder('👤 เลือกผู้ใช้ที่ต้องการจัดการเงิน...');

                return interaction.reply({
                    content: "📌 **กรุณาเลือกผู้ใช้งานที่ต้องการเพิ่ม/ลด/ตั้งค่ายอดเงิน:**",
                    components: [new ActionRowBuilder().addComponents(userSelect)],
                    ephemeral: true
                });
            }

            if (interaction.customId === 'btn_admin_check_user') {
                const userSelect = new UserSelectMenuBuilder()
                    .setCustomId('select_admin_check_user')
                    .setPlaceholder('🔍 เลือกผู้ใช้ที่ต้องการเช็กข้อมูล...');

                return interaction.reply({
                    content: "📌 **กรุณาเลือกผู้ใช้งานที่ต้องการเช็กยอดเงิน:**",
                    components: [new ActionRowBuilder().addComponents(userSelect)],
                    ephemeral: true
                });
            }

            // เลือกห้องแจกผ่าน ChannelSelectMenu
            if (interaction.customId === 'btn_admin_give_item') {
                const channelSelect = new ChannelSelectMenuBuilder()
                    .setCustomId('select_admin_give_item_channel')
                    .setPlaceholder('📢 เลือกห้องที่ต้องการจัดกิจกรรมแจกโปรแกรม...')
                    .setChannelTypes([ChannelType.GuildText]);

                return interaction.reply({
                    content: "📌 **เลือกห้องที่ต้องการส่งข้อความกิจกรรมแจกโปรแกรม/ของ:**",
                    components: [new ActionRowBuilder().addComponents(channelSelect)],
                    ephemeral: true
                });
            }

            if (interaction.customId === 'btn_admin_give_points') {
                const channelSelect = new ChannelSelectMenuBuilder()
                    .setCustomId('select_admin_give_points_channel')
                    .setPlaceholder('📢 เลือกห้องที่ต้องการจัดกิจกรรมแจกพอยต์...')
                    .setChannelTypes([ChannelType.GuildText]);

                return interaction.reply({
                    content: "📌 **เลือกห้องที่ต้องการส่งข้อความกิจกรรมแจกพอยต์:**",
                    components: [new ActionRowBuilder().addComponents(channelSelect)],
                    ephemeral: true
                });
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

                let desc = products.map((p, i) => `${i + 1}. **${p.name}** (ID: \`${p.id}\`) - ราคา **${p.price} บาท** (คงเหลือ: ${Array.isArray(p.stock) ? p.stock.length : 0} ชิ้น)`).join('\n');
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
                    content: `📥 **กรุณาส่ง/แนบรูปภาพสลิปของคุณลงในช่องแชทนี้ได้เลยครับ!**\n*(ระบบกำลังรอรับรูปสลิปจากคุณเป็นเวลา 5 นาที...)*`,
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
        }

        // --- 3. Select Menu Handlers ---
        if (interaction.isSelectMenu()) {

            // แอดมินเลือกลบสินค้า
            if (interaction.customId === 'select_admin_delete_product') {
                const productId = interaction.values[0];
                let products = getProducts();
                products = products.filter(p => p.id !== productId);
                saveProducts(products);
                return interaction.reply({ content: `🗑️ ลบสินค้า ID \`${productId}\` เรียบร้อยแล้ว`, ephemeral: true });
            }

            // แอดมินเลือกสินค้าเพื่อเพิ่มสต็อก (ขึ้น Modal ถามจำนวน)
            if (interaction.customId === 'select_admin_add_stock') {
                const productId = interaction.values[0];
                tempAdminData.set(interaction.user.id, { productId });

                const modal = new ModalBuilder().setCustomId('modal_admin_add_stock_count').setTitle('📈 เพิ่มจำนวนสต็อกสินค้า');
                modal.addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('stock_count')
                            .setLabel('จำนวนสต็อก/สิทธิ์ที่ต้องการเพิ่ม')
                            .setPlaceholder('เช่น 20')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true)
                    )
                );
                return await interaction.showModal(modal);
            }

            // แอดมินเลือกล้างสต็อก
            if (interaction.customId === 'select_admin_remove_stock') {
                const productId = interaction.values[0];
                const products = getProducts();
                const p = products.find(x => x.id === productId);
                if (p) {
                    p.stock = [];
                    saveProducts(products);
                    return interaction.reply({ content: `📉 ล้างสต็อกสินค้า \`${p.name}\` เรียบร้อยแล้ว`, ephemeral: true });
                }
            }

            // แอดมินเลือกผู้ใช้เพื่อปรับเงิน (ขึ้น Modal ถาม action และจำนวนเงิน)
            if (interaction.customId === 'select_admin_balance_user') {
                const targetUserId = interaction.values[0];
                tempAdminData.set(interaction.user.id, { targetUserId });

                const modal = new ModalBuilder().setCustomId('modal_admin_manage_balance_exec').setTitle('💳 จัดการเงินผู้ใช้');
                modal.addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('u_action')
                            .setLabel('การดำเนินการ (add = เพิ่ม, remove = ลด, set = ตั้งค่า)')
                            .setPlaceholder('พิมพ์ add หรือ remove หรือ set')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true)
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('u_amount')
                            .setLabel('จำนวนเงิน (พอยต์)')
                            .setPlaceholder('เช่น 100')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true)
                    )
                );
                return await interaction.showModal(modal);
            }

            // แอดมินเลือกผู้ใช้เพื่อเช็กเงิน
            if (interaction.customId === 'select_admin_check_user') {
                const targetUserId = interaction.values[0];
                const balances = getBalances();
                const bal = balances[targetUserId] || 0;
                return interaction.reply({ content: `🔍 **ข้อมูลผู้ใช้:** <@${targetUserId}>\n💳 **ยอดเงินคงเหลือ:** **${bal.toFixed(2)} บาท**`, ephemeral: true });
            }

            // แอดมินเลือกห้องแจกโปรแกรม (ขึ้น Modal กรอกรายละเอียด)
            if (interaction.customId === 'select_admin_give_item_channel') {
                const channelId = interaction.values[0];
                tempAdminData.set(interaction.user.id, { channelId });

                const modal = new ModalBuilder().setCustomId('modal_admin_give_item_exec').setTitle('🎁 รายละเอียดกิจกรรมแจกโปรแกรม');
                modal.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('g_title').setLabel('หัวข้อกิจกรรม').setPlaceholder('เช่น แจกฟรี โปรแกรม VIP LucaShop').setStyle(TextInputStyle.Short).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('g_name').setLabel('ชื่อของที่จะแจก / รายละเอียดกิจกรรม').setPlaceholder('ใส่ชื่อของ และรายละเอียดกติกา').setStyle(TextInputStyle.Paragraph).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('g_download').setLabel('ลิงก์ดาวน์โหลดโปรแกรม').setPlaceholder('https://... (เว้นว่างได้)').setStyle(TextInputStyle.Short).setRequired(false)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('g_more').setLabel('จำนวนคนรับ / ยศรับ / ยศแท็ก / รูปภาพ').setPlaceholder('รูปแบบ: ลิมิตคน|IDยศที่จะแจก|ยศแท็ก|URLรูปภาพ (เว้นช่องได้)').setStyle(TextInputStyle.Short).setRequired(true))
                );
                return await interaction.showModal(modal);
            }

            // แอดมินเลือกห้องแจกพอยต์ (ขึ้น Modal กรอกรายละเอียด)
            if (interaction.customId === 'select_admin_give_points_channel') {
                const channelId = interaction.values[0];
                tempAdminData.set(interaction.user.id, { channelId });

                const modal = new ModalBuilder().setCustomId('modal_admin_give_points_exec').setTitle('💎 รายละเอียดกิจกรรมแจกพอยต์');
                modal.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('p_title').setLabel('หัวข้อกิจกรรม').setPlaceholder('เช่น กิจกรรมแจกพอยต์ฟรี 50 พอยต์').setStyle(TextInputStyle.Short).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('p_desc').setLabel('รายละเอียดกิจกรรม').setPlaceholder('รายละเอียดกติกา').setStyle(TextInputStyle.Paragraph).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('p_amount').setLabel('จำนวนพอยต์ต่อคน').setPlaceholder('เช่น 50').setStyle(TextInputStyle.Short).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('p_more').setLabel('จำนวนคนรับ / ยศแท็ก / ลิงก์รูปภาพ').setPlaceholder('รูปแบบ: ลิมิตคน|ยศแท็ก|URLรูปภาพ (เช่น 10|@everyone|https://...)').setStyle(TextInputStyle.Short).setRequired(true))
                );
                return await interaction.showModal(modal);
            }

            // ผู้ใช้กดเลือกซื้อสินค้า
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

                // แจกยศถ้ามีการตั้งค่าไว้
                if (product.roleId) {
                    try {
                        const role = interaction.guild.roles.cache.get(product.roleId);
                        if (role) await interaction.member.roles.add(role);
                    } catch (e) {
                        console.log("Cannot add product role:", e);
                    }
                }

                let replyMsg = `📦 **สินค้า:** ${product.name}\n💰 **ราคา:** ${product.price} บาท\n💳 **เงินคงเหลือ:** ${balances[interaction.user.id]} บาท\n\n🔑 **ข้อมูลสินค้า/สิทธิ์ของคุณ:**\n\`\`\`${itemReceived}\`\`\``;
                if (product.downloadUrl && product.downloadUrl.startsWith('http')) {
                    replyMsg += `\n\n📥 **ลิงก์ดาวน์โหลดสินค้า:**\n${product.downloadUrl}`;
                }

                return interaction.reply({
                    embeds: [new EmbedBuilder()
                        .setColor("Green")
                        .setTitle("🎉 สั่งซื้อสินค้าสำเร็จ!")
                        .setDescription(replyMsg)
                    ],
                    ephemeral: true
                });
            }
        }

        // --- 4. Modal Submits ---
        if (interaction.isModalSubmit()) {

            if (interaction.customId === 'modal_admin_add_product') {
                const id = interaction.fields.getTextInputValue('p_id').trim();
                const name = interaction.fields.getTextInputValue('p_name').trim();
                const price = Number(interaction.fields.getTextInputValue('p_price').trim());
                const downloadUrl = interaction.fields.getTextInputValue('p_download') || '';
                const roleId = interaction.fields.getTextInputValue('p_role') || '';

                const products = getProducts();
                if (products.some(p => p.id === id)) return interaction.reply({ content: `❌ มีสินค้า ID \`${id}\` แล้ว`, ephemeral: true });

                products.push({ id, name, price, downloadUrl, roleId, stock: [] });
                saveProducts(products);
                return interaction.reply({ content: `✅ เพิ่มสินค้า \`${name}\` (ID: ${id}) ราคา ${price} บาท เรียบร้อยแล้ว!`, ephemeral: true });
            }

            if (interaction.customId === 'modal_admin_add_stock_count') {
                const temp = tempAdminData.get(interaction.user.id);
                if (!temp || !temp.productId) return interaction.reply({ content: "❌ เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง", ephemeral: true });

                const count = parseInt(interaction.fields.getTextInputValue('stock_count').trim()) || 0;
                if (count <= 0) return interaction.reply({ content: "❌ กรุณากรอกจำนวนตัวเลขที่มากกว่า 0", ephemeral: true });

                const products = getProducts();
                const p = products.find(x => x.id === temp.productId);
                if (!p) return interaction.reply({ content: "❌ ไม่พบสินค้านี้", ephemeral: true });

                if (!Array.isArray(p.stock)) p.stock = [];
                for (let i = 0; i < count; i++) {
                    p.stock.push(`[สิทธิ์การใช้งานสินค้า - ${p.name}]`);
                }
                saveProducts(products);
                tempAdminData.delete(interaction.user.id);

                return interaction.reply({ content: `📈 เติมสต็อกสินค้า \`${p.name}\` จำนวน **${count} ชิ้น** เรียบร้อยแล้ว! (รวมคงเหลือ: ${p.stock.length} ชิ้น)`, ephemeral: true });
            }

            if (interaction.customId === 'modal_admin_manage_balance_exec') {
                const temp = tempAdminData.get(interaction.user.id);
                if (!temp || !temp.targetUserId) return interaction.reply({ content: "❌ เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง", ephemeral: true });

                const action = interaction.fields.getTextInputValue('u_action').trim().toLowerCase();
                const amount = Number(interaction.fields.getTextInputValue('u_amount').trim());

                const balances = getBalances();
                let cur = balances[temp.targetUserId] || 0;
                if (action === 'add') cur += amount;
                else if (action === 'remove') cur = Math.max(0, cur - amount);
                else if (action === 'set') cur = amount;

                balances[temp.targetUserId] = cur;
                saveBalances(balances);
                tempAdminData.delete(interaction.user.id);

                return interaction.reply({ content: `💳 อัปเดตยอดเงินของผู้ใช้ <@${temp.targetUserId}> เป็น **${cur.toFixed(2)} บาท** เรียบร้อย!`, ephemeral: true });
            }

            if (interaction.customId === 'modal_admin_give_item_exec') {
                const temp = tempAdminData.get(interaction.user.id);
                if (!temp || !temp.channelId) return interaction.reply({ content: "❌ เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง", ephemeral: true });

                const title = interaction.fields.getTextInputValue('g_title').trim();
                const nameAndDesc = interaction.fields.getTextInputValue('g_name').trim();
                const downloadUrl = interaction.fields.getTextInputValue('g_download') || '';
                const moreOpts = interaction.fields.getTextInputValue('g_more').trim();

                const targetChannel = interaction.guild.channels.cache.get(temp.channelId);
                if (!targetChannel) return interaction.reply({ content: `❌ ไม่พบห้องในเซิร์ฟเวอร์นี้`, ephemeral: true });

                const parsed = parseGiveawayMoreOptions(moreOpts);
                const giveawayId = `GW-ITEM-${Date.now()}`;
                const giveaways = getGiveaways();

                giveaways[giveawayId] = {
                    id: giveawayId,
                    type: 'item',
                    itemName: title,
                    downloadUrl,
                    limit: parsed.limit,
                    giveRoleId: parsed.giveRoleId,
                    claimedUsers: [],
                    createdAt: new Date().toISOString()
                };
                saveGiveaways(giveaways);

                const embed = new EmbedBuilder()
                    .setTitle(`🎁 กิจกรรมแจกโปรแกรม/ของ: ${title}`)
                    .setDescription(`${nameAndDesc}\n\n👥 **จำนวนสิทธิ์:** จำกัด ${parsed.limit} คนเท่านั้น!`)
                    .setColor('Gold')
                    .setFooter({ text: `ผู้รับสิทธิ์แล้ว: 0/${parsed.limit} คน` })
                    .setTimestamp();

                if (parsed.imageUrl) embed.setImage(parsed.imageUrl);

                let contentMsg = parsed.roleMention || undefined;

                // สร้างเฉพาะปุ่มกดรับรางวัลเท่านั้น (ไม่ใส่ปุ่มลิงก์ดาวน์โหลดตรงนี้เพื่อป้องกันคนแอบกดดาวน์โหลดก่อน)
                const claimBtn = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`claim_giveaway_${giveawayId}`).setLabel('🎉 กดรับของรางวัล').setStyle(ButtonStyle.Success)
                );

                await targetChannel.send({ content: contentMsg, embeds: [embed], components: [claimBtn] });
                tempAdminData.delete(interaction.user.id);

                return interaction.reply({ content: `✅ สร้างกิจกรรมแจกของในห้อง <#${temp.channelId}> เรียบร้อยแล้ว!`, ephemeral: true });
            }

            if (interaction.customId === 'modal_admin_give_points_exec') {
                const temp = tempAdminData.get(interaction.user.id);
                if (!temp || !temp.channelId) return interaction.reply({ content: "❌ เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง", ephemeral: true });

                const title = interaction.fields.getTextInputValue('p_title').trim();
                const desc = interaction.fields.getTextInputValue('p_desc').trim();
                const amount = Number(interaction.fields.getTextInputValue('p_amount').trim());
                const moreOpts = interaction.fields.getTextInputValue('p_more').trim();

                const targetChannel = interaction.guild.channels.cache.get(temp.channelId);
                if (!targetChannel) return interaction.reply({ content: `❌ ไม่พบห้องในเซิร์ฟเวอร์นี้`, ephemeral: true });

                const parsed = parseGiveawayMoreOptions(moreOpts);
                const giveawayId = `GW-POINTS-${Date.now()}`;
                const giveaways = getGiveaways();

                giveaways[giveawayId] = {
                    id: giveawayId,
                    type: 'points',
                    pointsAmount: amount,
                    limit: parsed.limit,
                    claimedUsers: [],
                    createdAt: new Date().toISOString()
                };
                saveGiveaways(giveaways);

                const embed = new EmbedBuilder()
                    .setTitle(`💎 กิจกรรมแจกพอยต์: ${title}`)
                    .setDescription(`${desc}\n\n💰 **แจกพอยต์:** **${amount} พอยต์/คน**\n👥 **จำนวนสิทธิ์:** จำกัด ${parsed.limit} คนเท่านั้น!`)
                    .setColor('Blue')
                    .setFooter({ text: `ผู้รับสิทธิ์แล้ว: 0/${parsed.limit} คน` })
                    .setTimestamp();

                if (parsed.imageUrl) embed.setImage(parsed.imageUrl);

                let contentMsg = parsed.roleMention || undefined;

                const claimBtn = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`claim_giveaway_${giveawayId}`).setLabel('💎 กดรับพอยต์').setStyle(ButtonStyle.Primary)
                );

                await targetChannel.send({ content: contentMsg, embeds: [embed], components: [claimBtn] });
                tempAdminData.delete(interaction.user.id);

                return interaction.reply({ content: `✅ สร้างกิจกรรมแจกพอยต์ในห้อง <#${temp.channelId}> เรียบร้อยแล้ว!`, ephemeral: true });
            }

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

                    interaction.reply({ embeds: [new EmbedBuilder().setColor("Green").setTitle("✅ เติมเงินสำเร็จ (TrueMoney)").setDescription(`💰 จำนวน: **${amount} บาท**\n💳 ยอดคงเหลือใหม่: **${balances[interaction.user.id]} บาท**`)], ephemeral: true });

                    if (config.channellog) {
                        const logChannel = interaction.guild.channels.cache.get(config.channellog);
                        if (logChannel) logChannel.send({ embeds: [new EmbedBuilder().setColor("Green").setTitle("🧧 เติมเงินสำเร็จ (TrueMoney)").setDescription(`👤 ผู้เติม: <@${interaction.user.id}>\n💰 จำนวน: **${amount} บาท**`)] });
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
