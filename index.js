const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Bot LucaShop is running 24/7!');
});

app.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
});

const { Client, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, ActivityType } = require('discord.js');

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

const botToken = process.env.TOKEN || config.token;

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
        .setDescription('• เติมเงินผ่านซองทรูมันนี่\n• เลือกซื้อสินค้าและโปรแกรมได้ทันทีผ่านปุ่มด้านล่าง\n• เลือกโปรแกรมฟรีได้ข้างล่าง')
        .setColor('Blue');
    
    if (config.imageUrl && config.imageUrl !== "") embed.setImage(config.imageUrl);

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('topup_menu').setLabel('💰 เติมเงิน (ซองอั่งเปา)').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('check_balance').setLabel('💳 ดูยอดเงินในบัญชี').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('buy_menu').setLabel('🛒 เลือกซื้อสินค้า').setStyle(ButtonStyle.Secondary)
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('view_prices').setLabel('❓ ดูรายการสินค้าและราคา').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('contact_admin').setLabel('🎫 ติดต่อแอดมิน').setStyle(ButtonStyle.Danger)
    );

    return { embeds: [embed], components: [row1, row2] };
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

                // ตัดเงินและหักสต็อก
                balances[interaction.user.id] -= product.price;
                saveBalances(balances);

                product.stock = currentStock - 1;
                saveProducts(products);

                const purchases = getPurchases();
                if (!purchases[interaction.user.id]) purchases[interaction.user.id] = [];
                purchases[interaction.user.id].push({ productName: product.name, price: product.price, date: new Date().toISOString() });
                savePurchases(purchases);

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

process.on('unhandledRejection', (reason, p) => console.log(' [Anti-Crash] :: Unhandled Rejection', reason));
process.on('uncaughtException', (err, origin) => console.log(' [Anti-Crash] :: Uncaught Exception', err));

client.login(botToken);
