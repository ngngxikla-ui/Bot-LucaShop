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

// จัดการฐานข้อมูลยอดเงิน
const DB_FILE = './balances.json';
function getBalances() {
    if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({}));
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function saveBalances(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 4));
}

// จัดการฐานข้อมูลประวัติการซื้อ
const PURCHASE_FILE = './purchases.json';
function getPurchases() {
    if (!fs.existsSync(PURCHASE_FILE)) fs.writeFileSync(PURCHASE_FILE, JSON.stringify({}));
    return JSON.parse(fs.readFileSync(PURCHASE_FILE, 'utf8'));
}
function savePurchases(data) {
    fs.writeFileSync(PURCHASE_FILE, JSON.stringify(data, null, 4));
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
// ลงทะเบียน Slash Commands ครบทุกฟังก์ชัน
// ---------------------------------------------------------
let commandsMap = new Map();

commandsMap.set("setup", {
    name: "setup",
    description: "ติดตั้งหน้าต่างเมนูร้านค้าสำหรับลูกค้า (Admin Only)",
});

commandsMap.set("admin_room", {
    name: "admin_room",
    description: "เปิดแผงควบคุมร้านค้าสำหรับแอดมิน (Control Room)",
});

commandsMap.set("addproduct", {
    name: "addproduct",
    description: "➕ เพิ่มสินค้าใหม่เข้าสู่ร้านค้า (Admin Only)",
});

commandsMap.set("deleteproduct", {
    name: "deleteproduct",
    description: "🗑️ ลบสินค้าออกจากร้านค้า (Admin Only)",
});

commandsMap.set("addstock", {
    name: "addstock",
    description: "📈 เพิ่มจำนวนสต็อกสินค้า (Admin Only)",
});

commandsMap.set("removestock", {
    name: "removestock",
    description: "📉 ลดจำนวนสต็อกสินค้า (Admin Only)",
});

commandsMap.set("checkstock", {
    name: "checkstock",
    description: "📊 เช็คสต็อกและรายงานสินค้าทั้งหมด (Admin Only)",
});

commandsMap.set("addmoney", {
    name: "addmoney",
    description: "💰 เพิ่มเงินให้บัญชีลูกค้า (Admin Only)",
    options: [
        { name: "user", description: "เลือกผู้ใช้ที่ต้องการเพิ่มเงิน", type: 6, required: true },
        { name: "amount", description: "จำนวนเงินที่ต้องการเพิ่ม", type: 4, required: true }
    ]
});

commandsMap.set("removemoney", {
    name: "removemoney",
    description: "💸 หักเงินออกจากบัญชีลูกค้า (Admin Only)",
    options: [
        { name: "user", description: "เลือกผู้ใช้ที่ต้องการหักเงิน", type: 6, required: true },
        { name: "amount", description: "จำนวนเงินที่ต้องการหัก", type: 4, required: true }
    ]
});

commandsMap.set("checkmoney", {
    name: "checkmoney",
    description: "💳 เช็คยอดเงินในบัญชีลูกค้า (Admin Only)",
    options: [
        { name: "user", description: "เลือกผู้ใช้ที่ต้องการเช็ค", type: 6, required: true }
    ]
});

commandsMap.set("checkuser", {
    name: "checkuser",
    description: "🔍 เช็คประวัติการซื้อและข้อมูลของลูกค้า (Admin Only)",
    options: [
        { name: "user", description: "เลือกผู้ใช้ที่ต้องการเช็ค", type: 6, required: true }
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

// ฟังก์ชันสร้างหน้าเมนูร้านค้า (ลูกค้า)
function createShopMenu() {
    const embed = new EmbedBuilder()
        .setTitle('🛒 LucaShop')
        .setDescription('• เติมเงินผ่านซองทรูมันนี่\n• เลือกซื้อสินค้าและโปรแกรมได้ทันทีผ่านปุ่มด้านล่าง\n• เลือกโปรแกรมฟรีได้ข้างล่าง')
        .setColor('Blue');
    
    if (config.imageUrl && config.imageUrl !== "") {
        embed.setImage(config.imageUrl);
    }

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

// ฟังก์ชันสร้างหน้า Control Room (แอดมิน)
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

// ฟังก์ชันสร้าง Modal เพิ่มสินค้า (แก้ปัญหาให้ใส่/ไม่ใส่ยศ หรือรูปภาพก็ได้)
function buildAddProductModal() {
    const modal = new ModalBuilder().setCustomId('setup2_modal').setTitle('➕ เพิ่มสินค้าและตั้งค่า');

    const nameInput = new TextInputBuilder().setCustomId('prod_name').setLabel("ชื่อสินค้า").setStyle(TextInputStyle.Short).setRequired(true);
    const priceInput = new TextInputBuilder().setCustomId('prod_price').setLabel("ราคา (บาท)").setStyle(TextInputStyle.Short).setRequired(true);
    const stockInput = new TextInputBuilder().setCustomId('prod_stock').setLabel("จำนวนสต็อก (เช่น 10)").setStyle(TextInputStyle.Short).setRequired(true);
    
    // ไม่บังคับกรอกยศ (setRequired: false)
    const roleInput = new TextInputBuilder().setCustomId('prod_role').setLabel("Role ID ให้ยศอัตโนมัติ (ไม่ใส่ให้เว้นว่างไว้)").setStyle(TextInputStyle.Short).setRequired(false);
    
    // ไม่บังคับกรอกลิงก์และรูป (setRequired: false)
    const linkAndImage = new TextInputBuilder()
        .setCustomId('prod_links')
        .setLabel("ลิงก์ไฟล์ (บรรทัด1) และ ลิงก์รูป (บรรทัด2) ถ้ามี")
        .setPlaceholder("บรรทัดที่ 1: ลิงก์ดาวน์โหลดสินค้า\nบรรทัดที่ 2: ลิงก์รูปภาพตัวอย่าง")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false);

    modal.addComponents(
        new ActionRowBuilder().addComponents(nameInput),
        new ActionRowBuilder().addComponents(priceInput),
        new ActionRowBuilder().addComponents(stockInput),
        new ActionRowBuilder().addComponents(roleInput),
        new ActionRowBuilder().addComponents(linkAndImage)
    );

    return modal;
}

// ---------------------------------------------------------
// ระบบ Interaction และการทำงานหลัก
// ---------------------------------------------------------
client.on("interactionCreate", async (interaction) => {
    
    // --- 1. คำสั่ง Slash Commands ---
    if (interaction.isChatInputCommand()) {
        if (!isAdmin(interaction)) {
            return interaction.reply({ content: "❌ คุณไม่มีสิทธิ์ใช้คำสั่งนี้ (สำหรับ Admin เท่านั้น)", ephemeral: true });
        }

        if (interaction.commandName === 'setup') {
            return await interaction.reply(createShopMenu());
        }

        if (interaction.commandName === 'admin_room') {
            return await interaction.reply(getAdminPanel());
        }

        if (interaction.commandName === 'addproduct') {
            return await interaction.showModal(buildAddProductModal());
        }

        if (interaction.commandName === 'deleteproduct') {
            if (!config.products || config.products.length === 0) return interaction.reply({ content: "❌ ยังไม่มีสินค้าในระบบให้ลบ", ephemeral: true });
            const selectMenu = new StringSelectMenuBuilder().setCustomId('select_delete_product').setPlaceholder('ถังขยะ: เลือกสินค้าที่ต้องการลบถาวร');
            config.products.forEach(prod => {
                selectMenu.addOptions({ label: `🗑️ ${prod.name}`, description: `ลบสินค้านี้ออกจากระบบ | ราคา: ${prod.price} บาท`, value: prod.id });
            });
            return await interaction.reply({ content: "⚠️ **โปรดเลือกสินค้าที่คุณต้องการลบทิ้งถาวร:**", components: [new ActionRowBuilder().addComponents(selectMenu)], ephemeral: true });
        }

        if (interaction.commandName === 'addstock' || interaction.commandName === 'removestock') {
            if (!config.products || config.products.length === 0) return interaction.reply({ content: "❌ ยังไม่มีสินค้าในระบบ", ephemeral: true });
            const actionType = interaction.commandName === 'addstock' ? "add" : "remove";
            const selectMenu = new StringSelectMenuBuilder().setCustomId(`stock_action_${actionType}`).setPlaceholder('เลือกสินค้าที่ต้องการปรับสต็อก');
            config.products.forEach(prod => {
                let stockCount = prod.stock !== undefined ? prod.stock : 0;
                selectMenu.addOptions({ label: prod.name, description: `สต็อกปัจจุบัน: ${stockCount} ชิ้น`, value: prod.id });
            });
            return await interaction.reply({ content: `📦 **โปรดเลือกสินค้าที่ต้องการ${actionType === 'add' ? 'เพิ่ม' : 'ลด'}สต็อก:**`, components: [new ActionRowBuilder().addComponents(selectMenu)], ephemeral: true });
        }

        if (interaction.commandName === 'checkstock') {
            const purchases = getPurchases();
            let desc = "📋 **รายงานสถานะสินค้าทั้งหมด:**\n\n";
            if (!config.products || config.products.length === 0) {
                desc += "ยังไม่มีสินค้าในระบบ";
            } else {
                config.products.forEach((p, index) => {
                    let stockCount = p.stock !== undefined ? p.stock : 0;
                    let totalSold = 0;
                    Object.values(purchases).forEach(userPurchases => {
                        userPurchases.forEach(up => { if (up.productName === p.name) totalSold++; });
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

            return await interaction.reply({
                content: `✅ **${interaction.commandName === 'addmoney' ? 'เพิ่ม' : 'หัก'}เงิน** จำนวน **${amount} บาท** ให้กับ <@${targetUser.id}> สำเร็จ\n💰 ยอดเงินคงเหลือปัจจุบัน: **${balances[targetUser.id]} บาท**`,
                ephemeral: true
            });
        }

        if (interaction.commandName === 'checkmoney') {
            const targetUser = interaction.options.getUser('user');
            const balances = getBalances();
            const userBalance = balances[targetUser.id] || 0;
            return await interaction.reply({ content: `💳 ยอดเงินของ <@${targetUser.id}> คือ **${userBalance} บาท**`, ephemeral: true });
        }

        if (interaction.commandName === 'checkuser') {
            const targetUser = interaction.options.getUser('user');
            const balances = getBalances();
            const purchases = getPurchases();

            const userBalance = balances[targetUser.id] || 0;
            const userPurchases = purchases[targetUser.id] || [];
            let purchaseHistory = userPurchases.length > 0 ? userPurchases.map(p => `• **${p.productName}** (${p.price} บาท) - เมื่อ ${new Date(p.date).toLocaleString('th-TH')}`).join('\n') : "ยังไม่มีประวัติการซื้อสินค้า";

            const embed = new EmbedBuilder()
                .setColor("Purple")
                .setTitle(`🔍 ข้อมูลผู้ใช้: ${targetUser.tag}`)
                .addFields(
                    { name: "💳 ยอดเงินคงเหลือ", value: `${userBalance} บาท`, inline: true },
                    { name: "🛒 ประวัติการซื้อสินค้า", value: purchaseHistory, inline: false }
                );

            return await interaction.reply({ embeds: [embed], ephemeral: true });
        }
    }

    // --- 2. ปุ่มกด Button ---
    if (interaction.isButton()) {
        
        // ลูกค้า
        if (interaction.customId === "topup_menu") {
            const modal = new ModalBuilder().setCustomId('topup_modal').setTitle('เติมเงินด้วยซองอั่งเปา TrueMoney');
            const codeInput = new TextInputBuilder().setCustomId('codeInput').setLabel("ใส่ลิ้งค์ซองอังเปาที่นี่").setPlaceholder('https://gift.truemoney.com/campaign/?v=...').setStyle(TextInputStyle.Short).setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(codeInput));
            await interaction.showModal(modal);
        }

        if (interaction.customId === "check_balance") {
            const balances = getBalances();
            const userBalance = balances[interaction.user.id] || 0;
            await interaction.reply({ embeds: [new EmbedBuilder().setColor("Blurple").setTitle("💳 ยอดเงินคงเหลือของคุณ").setDescription(`บัญชีของคุณ: <@${interaction.user.id}>\n💰 ยอดเงินสะสม: **${userBalance} บาท**`)], ephemeral: true });
        }

        if (interaction.customId === "buy_menu") {
            if (!config.products || config.products.length === 0) return interaction.reply({ content: "❌ ขณะนี้ยังไม่มีสินค้าเปิดขาย", ephemeral: true });

            const selectMenu = new StringSelectMenuBuilder().setCustomId('select_product').setPlaceholder('เลือกสินค้าที่คุณต้องการซื้อ');
            config.products.forEach(prod => {
                let stockCount = prod.stock !== undefined ? prod.stock : 0;
                let stockLabel = stockCount > 0 ? ` (เหลือ ${stockCount} ชิ้น)` : " (สินค้าหมด)";
                selectMenu.addOptions({ label: prod.name + stockLabel, description: `ราคา ${prod.price} บาท | สต็อก: ${stockCount} ชิ้น`, value: prod.id });
            });

            await interaction.reply({ content: "🛒 **โปรดเลือกสินค้าที่คุณต้องการซื้อจากรายการด้านล่าง:**", components: [new ActionRowBuilder().addComponents(selectMenu)], ephemeral: true });
        }

        if (interaction.customId === "view_prices") {
            let desc = "📋 **รายการสินค้าทั้งหมดที่มีจำหน่าย:**\n\n";
            config.products.forEach((p, index) => {
                let stockCount = p.stock !== undefined ? p.stock : 0;
                let stockDisplay = stockCount > 0 ? `📦 สต็อกเหลือ: **${stockCount} ชิ้น**` : "❌ **สินค้าหมดสต็อก**";
                let roleDisplay = (p.roleId && p.roleId.trim() !== "") ? `<@&${p.roleId}>` : "ไม่มี";
                desc += `**${index + 1}. ${p.name}**\n💵 ราคา: **${p.price} บาท** | ${stockDisplay}\n🏷️ ยศที่จะได้รับ: ${roleDisplay}\n-----------------------------------\n`;
            });
            await interaction.reply({ embeds: [new EmbedBuilder().setColor("Green").setTitle("💰 รายการสินค้าและราคา").setDescription(desc)], ephemeral: true });
        }

        if (interaction.customId === "contact_admin") {
            await interaction.reply({ embeds: [new EmbedBuilder().setColor("Orange").setTitle("🎫 ต้องการความช่วยเหลือ?").setDescription(`คุณสามารถติดต่อแอดมินหรือเปิดทิกเก็ตได้ที่ห้องนี้เลยครับ: <#${config.ticketChannelId}>`)], ephemeral: true });
        }

        // ปุ่ม Control Room
        if (interaction.customId === "adm_prod_add") {
            if (!isAdmin(interaction)) return interaction.reply({ content: "❌ สำหรับ Admin เท่านั้น", ephemeral: true });
            return await interaction.showModal(buildAddProductModal());
        }

        if (interaction.customId === "adm_prod_del") {
            if (!isAdmin(interaction)) return interaction.reply({ content: "❌ สำหรับ Admin เท่านั้น", ephemeral: true });
            if (!config.products || config.products.length === 0) return interaction.reply({ content: "❌ ยังไม่มีสินค้าในระบบให้ลบ", ephemeral: true });

            const selectMenu = new StringSelectMenuBuilder().setCustomId('select_delete_product').setPlaceholder('ถังขยะ: เลือกสินค้าที่ต้องการลบถาวร');
            config.products.forEach(prod => { selectMenu.addOptions({ label: `🗑️ ${prod.name}`, description: `ลบสินค้านี้ออกจากระบบ | ราคา: ${prod.price} บาท`, value: prod.id }); });
            return await interaction.reply({ content: "⚠️ **โปรดเลือกสินค้าที่คุณต้องการลบทิ้งถาวร:**", components: [new ActionRowBuilder().addComponents(selectMenu)], ephemeral: true });
        }

        if (interaction.customId === "adm_stock_add" || interaction.customId === "adm_stock_remove") {
            if (!isAdmin(interaction)) return interaction.reply({ content: "❌ สำหรับ Admin เท่านั้น", ephemeral: true });
            if (!config.products || config.products.length === 0) return interaction.reply({ content: "❌ ยังไม่มีสินค้าในระบบ", ephemeral: true });

            const actionType = interaction.customId === "adm_stock_add" ? "add" : "remove";
            const selectMenu = new StringSelectMenuBuilder().setCustomId(`stock_action_${actionType}`).setPlaceholder('เลือกสินค้าที่ต้องการปรับสต็อก');
            config.products.forEach(prod => {
                let stockCount = prod.stock !== undefined ? prod.stock : 0;
                selectMenu.addOptions({ label: prod.name, description: `สต็อกปัจจุบัน: ${stockCount} ชิ้น`, value: prod.id });
            });
            return await interaction.reply({ content: `📦 **โปรดเลือกสินค้าที่ต้องการ${actionType === 'add' ? 'เพิ่ม' : 'ลด'}สต็อก:**`, components: [new ActionRowBuilder().addComponents(selectMenu)], ephemeral: true });
        }

        if (interaction.customId === "adm_stock_check") {
            if (!isAdmin(interaction)) return interaction.reply({ content: "❌ สำหรับ Admin เท่านั้น", ephemeral: true });
            const purchases = getPurchases();
            let desc = "📋 **รายงานสถานะสินค้าทั้งหมด:**\n\n";

            if (!config.products || config.products.length === 0) {
                desc += "ยังไม่มีสินค้าในระบบ";
            } else {
                config.products.forEach((p, index) => {
                    let stockCount = p.stock !== undefined ? p.stock : 0;
                    let totalSold = 0;
                    Object.values(purchases).forEach(userPurchases => {
                        userPurchases.forEach(up => { if (up.productName === p.name) totalSold++; });
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

    // --- 3. การเลือกจาก Select Menu ---
    if (interaction.isStringSelectMenu()) {
        
        // ซื้อสินค้า
        if (interaction.customId === 'select_product') {
            const productId = interaction.values[0];
            const product = config.products.find(p => p.id === productId);
            if (!product) return interaction.update({ content: "❌ ไม่พบสินค้านี้ในระบบ", components: [] });

            const currentStock = product.stock !== undefined ? product.stock : 0;
            if (currentStock <= 0) return interaction.update({ content: `❌ สินค้า **${product.name}** หมดสต็อก!`, components: [], ephemeral: true });

            const balances = getBalances();
            const userBalance = balances[interaction.user.id] || 0;

            if (userBalance < product.price) {
                return interaction.update({ content: `❌ เงินไม่พอซื้อ **${product.name}**\n💰 เงินของคุณ: **${userBalance} บาท** | ต้องการ: **${product.price} บาท**`, components: [], ephemeral: true });
            }

            balances[interaction.user.id] -= product.price;
            saveBalances(balances);

            product.stock = currentStock - 1;
            fs.writeFileSync('./config.json', JSON.stringify(config, null, 4), 'utf8');

            const purchases = getPurchases();
            if (!purchases[interaction.user.id]) purchases[interaction.user.id] = [];
            purchases[interaction.user.id].push({ productName: product.name, price: product.price, date: new Date().toISOString() });
            savePurchases(purchases);

            let roleStatusText = "";
            if (product.roleId && product.roleId.trim() !== "" && product.roleId.toLowerCase() !== "ไม่มี") {
                try {
                    const member = await interaction.guild.members.fetch(interaction.user.id);
                    await member.roles.add(product.roleId);
                    roleStatusText = "\n🏷️ **ได้รับยศสำเร็จ!**";
                } catch (err) {
                    roleStatusText = "\n⚠️ ซื้อสำเร็จ แต่ระบบมอบยศไม่ผ่าน (ตรวจสอบสิทธิ์บอท)";
                }
            }

            const downloadLink = (product.gofileUrl && product.gofileUrl.trim() !== "") ? `[คลิกเพื่อดาวน์โหลด](${product.gofileUrl})` : "ไม่มีไฟล์ให้ดาวน์โหลด";

            const successEmbed = new EmbedBuilder()
                .setColor("Green")
                .setTitle("✅ สั่งซื้อสินค้าสำเร็จ!")
                .setDescription(`คุณได้ซื้อ **${product.name}** เรียบร้อยแล้ว${roleStatusText}`)
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
            const productId = interaction.values[0];
            const prodIndex = config.products.findIndex(p => p.id === productId);
            if (prodIndex > -1) {
                const deletedName = config.products[prodIndex].name;
                config.products.splice(prodIndex, 1);
                fs.writeFileSync('./config.json', JSON.stringify(config, null, 4), 'utf8');
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

    // --- 4. การส่งข้อมูลจาก Modal ---
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

        // เพิ่มสินค้าใหม่
        if (interaction.customId === "setup2_modal") {
            if (!config.products) config.products = [];
            const newId = `prod_${Date.now()}`;

            let inputRole = (interaction.fields.getTextInputValue('prod_role') || "").trim();
            if (inputRole.toLowerCase() === "ไม่มี" || inputRole === "no") inputRole = "";

            const linksRaw = interaction.fields.getTextInputValue('prod_links') || "";
            const linksArr = linksRaw.split('\n').map(l => l.trim());
            const gofileUrl = linksArr[0] || "";
            const previewImage = linksArr[1] || "";

            const newProd = {
                id: newId,
                name: interaction.fields.getTextInputValue('prod_name'),
                price: parseFloat(interaction.fields.getTextInputValue('prod_price')) || 0,
                stock: parseInt(interaction.fields.getTextInputValue('prod_stock')) || 0,
                roleId: inputRole,
                gofileUrl: gofileUrl,
                previewImage: previewImage
            };

            config.products.push(newProd);
            fs.writeFileSync('./config.json', JSON.stringify(config, null, 4), 'utf8');

            await interaction.reply({
                content: `✅ เพิ่มสินค้า **${newProd.name}** สำเร็จ!\n📦 จำนวนสต็อก: **${newProd.stock} ชิ้น** | ราคา: **${newProd.price} บาท**`,
                ephemeral: true
            });
        }

        // บันทึกการเพิ่ม/ลดสต็อก
        if (interaction.customId.startsWith('stock_modal_')) {
            const parts = interaction.customId.split('_');
            const action = parts[2];
            const productId = parts.slice(3).join('_');
            const inputAmount = parseInt(interaction.fields.getTextInputValue('stock_amount'));

            if (isNaN(inputAmount) || inputAmount <= 0) return interaction.reply({ content: "❌ ตัวเลขไม่ถูกต้อง", ephemeral: true });

            const product = config.products.find(p => p.id === productId);
            if (!product) return interaction.reply({ content: "❌ ไม่พบสินค้านี้", ephemeral: true });

            if (product.stock === undefined) product.stock = 0;
            if (action === 'add') product.stock += inputAmount;
            else product.stock = Math.max(0, product.stock - inputAmount);

            fs.writeFileSync('./config.json', JSON.stringify(config, null, 4), 'utf8');
            await interaction.reply({ content: `✅ อัปเดตสต็อก **${product.name}**\n📦 คงเหลือ: **${product.stock} ชิ้น**`, ephemeral: true });
        }

        // จัดการเงินผ่าน Modal
        if (interaction.customId === 'money_modal_add' || interaction.customId === 'money_modal_remove') {
            const action = interaction.customId.includes('add') ? 'add' : 'remove';
            const targetUserId = interaction.fields.getTextInputValue('target_userid').trim();
            const amount = parseInt(interaction.fields.getTextInputValue('money_amount'));

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
});

process.on('unhandledRejection', (reason, p) => console.log(' [Anti-Crash] :: Unhandled Rejection'));
process.on('uncaughtException', (err, origin) => console.log(' [Anti-Crash] :: Uncaught Exception'));

client.login(botToken);
