const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Bot LucaShop is running 24/7!');
});

app.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
});

const { Client, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder } = require('discord.js');
const client = new Client({ intents: 32767 });
const tw = require('@fortune-inc/tw-voucher');
const config = require('./config.json');
const { REST } = require("@discordjs/rest");
const { Routes } = require("discord-api-types/v9");
const fs = require('fs');
const chalk = require('chalk');

// กำหนดตัวแปร Token รองรับทั้งจาก Render Environment และไฟล์ config.json
const botToken = process.env.TOKEN || config.token;

// จัดการฐานข้อมูลยอดเงิน (Balances Database)
const DB_FILE = './balances.json';
function getBalances() {
    if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({}));
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function saveBalances(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 4));
}

// จัดการฐานข้อมูลประวัติการซื้อ (Purchases Database)
const PURCHASE_FILE = './purchases.json';
function getPurchases() {
    if (!fs.existsSync(PURCHASE_FILE)) fs.writeFileSync(PURCHASE_FILE, JSON.stringify({}));
    return JSON.parse(fs.readFileSync(PURCHASE_FILE, 'utf8'));
}
function savePurchases(data) {
    fs.writeFileSync(PURCHASE_FILE, JSON.stringify(data, null, 4));
}

// ตรวจสอบว่าเป็น Admin หรือไม่
function isAdmin(userId) {
    return config.ownerID === userId;
}

let commandsMap = new Map();
commandsMap.set("setup", {
    name: "setup",
    description: "setup ตั้งค่าทั้งหมด (Admin Only)",
    options: []
});
commandsMap.set("setup stock", {
    name: "setup stock",
    description: "จัดการสต็อก (Admin Only)",
    options: []
});
commandsMap.set("addstock", {
    name: "addstock",
    description: "เพิ่มจำนวนสต็อกสินค้า (Admin Only)",
    options: [
        { name: "product_id", description: "ID สินค้า (เช่น prod_1) หรือชื่อสินค้า", type: 3, required: true },
        { name: "amount", description: "จำนวนที่ต้องการเพิ่ม", type: 4, required: true }
    ]
});
commandsMap.set("removestock", {
    name: "removestock",
    description: "เอาของออกจากสต็อก (Admin Only)",
    options: [
        { name: "product_id", description: "ID สินค้า (เช่น prod_1) หรือชื่อสินค้า", type: 3, required: true },
        { name: "amount", description: "จำนวนที่ต้องการเอาออก", type: 4, required: true }
    ]
});
commandsMap.set("addmoney", {
    name: "addmoney",
    description: "เพิ่มเงินให้บัญชี (Admin Only)",
    options: [
        { name: "user", description: "เลือกผู้ใช้", type: 6, required: true },
        { name: "amount", description: "จำนวนเงินที่ต้องการเพิ่ม", type: 4, required: true }
    ]
});
commandsMap.set("removemoney", {
    name: "removemoney",
    description: "เอาเงินออกจากบัญชี (Admin Only)",
    options: [
        { name: "user", description: "เลือกผู้ใช้", type: 6, required: true },
        { name: "amount", description: "จำนวนเงินที่ต้องการหัก", type: 4, required: true }
    ]
});
commandsMap.set("checkmoney", {
    name: "checkmoney",
    description: "เช็คยอดเงินบัญชี (Admin Only)",
    options: [
        { name: "user", description: "เลือกผู้ใช้ที่ต้องการเช็ค", type: 6, required: true }
    ]
});
commandsMap.set("checkuser", {
    name: "checkuser",
    description: "เช็คประวัติการซื้อสินค้าของผู้ใช้ (Admin Only)",
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
            console.log(chalk.green(`✅ เข้าสู่ระบบสำเร็จในชื่อ : ${client.user.tag}`));
        } catch (err) {
            console.error(err);
        }
    })();
});

// ฟังก์ชันสร้างหน้าเมนูหลัก
function createShopMenu() {
    const embed = new EmbedBuilder()
        .setTitle('🛒 LucaShop')
        .setDescription('• เติมเงินผ่านซองทรูมันนี่\n• เลือกซื้อสินค้าและโปรแกรมได้ทันทีผ่านปุ่มด้านล่าง\n• เลือกเอสโปรเเกรมฟรีได้ข้างล่าง')
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

client.on('messageCreate', async (message) => {
    if (message.content === '!setup') {
        if (!isAdmin(message.author.id)) {
            return message.reply({ content: "❌ คุณไม่มีสิทธิ์ใช้คำสั่งนี้ (สำหรับ Admin เท่านั้น)", ephemeral: true });
        }
        const menuData = createShopMenu();
        await message.channel.send(menuData);
        await message.delete().catch(() => {});
    }
});

client.on("interactionCreate", async (interaction) => {
    
    // 1. Slash Commands
    if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'setup') {
            if (!isAdmin(interaction.user.id)) {
                return interaction.reply({ content: "❌ คุณไม่มีสิทธิ์ใช้คำสั่งนี้ (สำหรับ Admin เท่านั้น)", ephemeral: true });
            }
            const menuData = createShopMenu();
            return await interaction.reply(menuData);
        }

        if (interaction.commandName === 'setup2') {
            if (!isAdmin(interaction.user.id)) {
                return interaction.reply({ content: "❌ คุณไม่มีสิทธิ์ใช้คำสั่งนี้ (สำหรับ Admin เท่านั้น)", ephemeral: true });
            }

            const modal = new ModalBuilder()
                .setCustomId('setup2_modal')
                .setTitle('➕ เพิ่มสินค้าและสต็อกใหม่');

            const nameInput = new TextInputBuilder().setCustomId('prod_name').setLabel("ชื่อสินค้า").setStyle(TextInputStyle.Short).setRequired(true);
            const priceInput = new TextInputBuilder().setCustomId('prod_price').setLabel("ราคา (บาท)").setStyle(TextInputStyle.Short).setRequired(true);
            const stockInput = new TextInputBuilder().setCustomId('prod_stock').setLabel("จำนวนสต็อก (เช่น 5)").setStyle(TextInputStyle.Short).setRequired(true);
            const gofileInput = new TextInputBuilder().setCustomId('prod_gofile').setLabel("ลิงก์ดาวน์โหลด (GoFile/อื่นๆ)").setStyle(TextInputStyle.Short).setRequired(false);
            const imageInput = new TextInputBuilder().setCustomId('prod_image').setLabel("ลิงก์รูปภาพตัวอย่างสินค้า").setStyle(TextInputStyle.Short).setRequired(false);

            modal.addComponents(
                new ActionRowBuilder().addComponents(nameInput),
                new ActionRowBuilder().addComponents(priceInput),
                new ActionRowBuilder().addComponents(stockInput),
                new ActionRowBuilder().addComponents(gofileInput),
                new ActionRowBuilder().addComponents(imageInput)
            );

            return await interaction.showModal(modal);
        }

        if (interaction.commandName === 'addstock') {
            if (!isAdmin(interaction.user.id)) return interaction.reply({ content: "❌ สำหรับ Admin เท่านั้น", ephemeral: true });
            const query = interaction.options.getString('product_id').trim();
            const amount = interaction.options.getInteger('amount');

            const product = config.products.find(p => p.id.toLowerCase() === query.toLowerCase() || p.name.includes(query));
            if (!product) return interaction.reply({ content: `❌ ไม่พบสินค้าที่ตรงกับ "${query}" (ตรวจสอบ ID หรือชื่อสินค้าให้ถูกต้อง)`, ephemeral: true });

            if (product.stock === undefined) product.stock = 0;
            product.stock += amount;
            fs.writeFileSync('./config.json', JSON.stringify(config, null, 4), 'utf8');

            return await interaction.reply({ content: `✅ เพิ่มสต็อกสินค้า **${product.name}** จำนวน **${amount} ชิ้น** สำเร็จ\n📦 สต็อกปัจจุบัน: **${product.stock} ชิ้น**`, ephemeral: true });
        }

        if (interaction.commandName === 'removestock') {
            if (!isAdmin(interaction.user.id)) return interaction.reply({ content: "❌ สำหรับ Admin เท่านั้น", ephemeral: true });
            const query = interaction.options.getString('product_id').trim();
            const amount = interaction.options.getInteger('amount');

            const product = config.products.find(p => p.id.toLowerCase() === query.toLowerCase() || p.name.includes(query));
            if (!product) return interaction.reply({ content: `❌ ไม่พบสินค้าที่ตรงกับ "${query}" (ตรวจสอบ ID หรือชื่อสินค้าให้ถูกต้อง)`, ephemeral: true });

            if (product.stock === undefined) product.stock = 0;
            product.stock = Math.max(0, product.stock - amount);
            fs.writeFileSync('./config.json', JSON.stringify(config, null, 4), 'utf8');

            return await interaction.reply({ content: `✅ ลดสต็อกสินค้า **${product.name}** จำนวน **${amount} ชิ้น** สำเร็จ\n📦 สต็อกปัจจุบัน: **${product.stock} ชิ้น**`, ephemeral: true });
        }

        if (interaction.commandName === 'addmoney') {
            if (!isAdmin(interaction.user.id)) return interaction.reply({ content: "❌ สำหรับ Admin เท่านั้น", ephemeral: true });
            const targetUser = interaction.options.getUser('user');
            const amount = interaction.options.getInteger('amount');

            const balances = getBalances();
            if (!balances[targetUser.id]) balances[targetUser.id] = 0;
            balances[targetUser.id] += amount;
            saveBalances(balances);

            return await interaction.reply({ content: `✅ เพิ่มเงินจำนวน **${amount} บาท** ให้กับ <@${targetUser.id}> สำเร็จแล้ว\n💰 ยอดเงินปัจจุบัน: **${balances[targetUser.id]} บาท**`, ephemeral: true });
        }

        if (interaction.commandName === 'removemoney') {
            if (!isAdmin(interaction.user.id)) return interaction.reply({ content: "❌ สำหรับ Admin เท่านั้น", ephemeral: true });
            const targetUser = interaction.options.getUser('user');
            const amount = interaction.options.getInteger('amount');

            const balances = getBalances();
            if (!balances[targetUser.id]) balances[targetUser.id] = 0;
            balances[targetUser.id] = Math.max(0, balances[targetUser.id] - amount);
            saveBalances(balances);

            return await interaction.reply({ content: `✅ หักเงินจำนวน **${amount} บาท** จาก <@${targetUser.id}> สำเร็จแล้ว\n💰 ยอดเงินปัจจุบัน: **${balances[targetUser.id]} บาท**`, ephemeral: true });
        }

        if (interaction.commandName === 'checkmoney') {
            if (!isAdmin(interaction.user.id)) return interaction.reply({ content: "❌ สำหรับ Admin เท่านั้น", ephemeral: true });
            const targetUser = interaction.options.getUser('user');
            const balances = getBalances();
            const userBalance = balances[targetUser.id] || 0;

            return await interaction.reply({ content: `💳 ยอดเงินของ <@${targetUser.id}> คือ **${userBalance} บาท**`, ephemeral: true });
        }

        if (interaction.commandName === 'checkuser') {
            if (!isAdmin(interaction.user.id)) return interaction.reply({ content: "❌ สำหรับ Admin เท่านั้น", ephemeral: true });
            const targetUser = interaction.options.getUser('user');

            const balances = getBalances();
            const purchases = getPurchases();
            const userBalance = balances[targetUser.id] || 0;
            const userPurchases = purchases[targetUser.id] || [];

            let purchaseHistory = userPurchases.length > 0 ? userPurchases.map(p => `• **${p.productName}** (${p.price} บาท) - เมื่อ ${new Date(p.date).toLocaleString()}`).join('\n') : "ยังไม่มีประวัติการซื้อสินค้า";

            const embed = new EmbedBuilder()
                .setColor("Purple")
                .setTitle(`🔍 ข้อมูลผู้ใช้: ${targetUser.tag}`)
                .addFields(
                    { name: "💳 ยอดเงินคงเหลือ", value: `${userBalance} บาท`, inline: true },
                    { name: "🛒 ประวัติการซื้อสินค้า", value: purchaseHistory, inline: false }
                )
                .setTimestamp();

            return await interaction.reply({ embeds: [embed], ephemeral: true });
        }
    }

    // 2. Buttons Handler
    if (interaction.isButton()) {
        if (interaction.customId === "topup_menu") {
            const modal = new ModalBuilder()
                .setCustomId('topup_modal')
                .setTitle('เติมเงินด้วยซองอั่งเปา TrueMoney');
            const codeInput = new TextInputBuilder()
                .setCustomId('codeInput')
                .setLabel("ใส่ลิ้งค์ซองอังเปาที่นี่")
                .setPlaceholder('https://gift.truemoney.com/campaign/?v=...')
                .setStyle(TextInputStyle.Short)
                .setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(codeInput));
            await interaction.showModal(modal);
        }

        if (interaction.customId === "check_balance") {
            const balances = getBalances();
            const userBalance = balances[interaction.user.id] || 0;
            await interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setColor("Blurple")
                        .setTitle("💳 ยอดเงินคงเหลือของคุณ")
                        .setDescription(`บัญชีของคุณ: <@${interaction.user.id}>\n💰 ยอดเงินสะสม: **${userBalance} บาท**`)
                ],
                ephemeral: true
            });
        }

        if (interaction.customId === "buy_menu") {
            if (!config.products || config.products.length === 0) {
                return interaction.reply({ content: "❌ ขณะนี้ยังไม่มีสินค้าเปิดขาย", ephemeral: true });
            }

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('select_product')
                .setPlaceholder('เลือกสินค้าที่คุณต้องการซื้อ');

            config.products.forEach(prod => {
                let stockCount = prod.stock !== undefined ? prod.stock : 0;
                let stockLabel = stockCount > 0 ? ` (เหลือ ${stockCount} ชิ้น)` : " (สินค้าหมด)";
                selectMenu.addOptions({
                    label: prod.name + stockLabel,
                    description: `ราคา ${prod.price} บาท | สต็อก: ${stockCount} ชิ้น`,
                    value: prod.id
                });
            });

            await interaction.reply({
                content: "🛒 **โปรดเลือกสินค้าที่คุณต้องการซื้อจากรายการด้านล่าง:**",
                components: [new ActionRowBuilder().addComponents(selectMenu)],
                ephemeral: true
            });
        }

        if (interaction.customId === "view_prices") {
            let desc = "📋 **รายการสินค้าทั้งหมดที่มีจำหน่าย:**\n\n";
            config.products.forEach((p, index) => {
                let stockCount = p.stock !== undefined ? p.stock : 0;
                let stockDisplay = stockCount > 0 ? `📦 สต็อกเหลือ: **${stockCount} ชิ้น**` : "❌ **สินค้าหมดสต็อก**";
                
                desc += `**${index + 1}. ${p.name}** (ID: \`${p.id}\`)\n`;
                desc += `💵 ราคา: **${p.price} บาท** | ${stockDisplay}\n-----------------------------------\n`;
            });

            await interaction.reply({
                embeds: [new EmbedBuilder().setColor("Green").setTitle("💰 รายการสินค้าและราคา").setDescription(desc)],
                ephemeral: true
            });
        }

        if (interaction.customId === "contact_admin") {
            await interaction.reply({
                embeds: [new EmbedBuilder().setColor("Orange").setTitle("🎫 ต้องการความช่วยเหลือ?").setDescription(`คุณสามารถติดต่อแอดมินหรือเปิดทิกเก็ตได้ที่ห้องนี้เลยครับ: <#${config.ticketChannelId}>`)],
                ephemeral: true
            });
        }
    }

    // 3. Select Menu Handler (เลือกสินค้าที่จะซื้อ)
    if (interaction.isStringSelectMenu()) {
        if (interaction.customId === 'select_product') {
            const productId = interaction.values[0];
            const product = config.products.find(p => p.id === productId);
            if (!product) return interaction.update({ content: "❌ ไม่พบสินค้านี้ในระบบ", components: [] });

            // เช็คสต็อกสินค้า
            const currentStock = product.stock !== undefined ? product.stock : 0;
            if (currentStock <= 0) {
                return interaction.update({
                    content: `❌ สินค้า **${product.name}** หมดสต็อกแล้วครับ! กรุณารอแอดมินเติมสต็อก`,
                    components: [],
                    ephemeral: true
                });
            }

            const balances = getBalances();
            const userBalance = balances[interaction.user.id] || 0;

            if (userBalance < product.price) {
                return interaction.update({
                    content: `❌ ยอดเงินของคุณไม่เพียงพอสำหรับการซื้อ **${product.name}**\n💰 เงินของคุณ: **${userBalance} บาท** | ต้องการ: **${product.price} บาท**\n(กรุณาเติมเงินเพิ่มก่อนทำรายการ)`,
                    components: [],
                    ephemeral: true
                });
            }

            // หักเงิน
            balances[interaction.user.id] -= product.price;
            saveBalances(balances);

            // หักสต็อกสินค้าลง 1 ชิ้น และบันทึกไฟล์ config.json ทันที
            product.stock = currentStock - 1;
            fs.writeFileSync('./config.json', JSON.stringify(config, null, 4), 'utf8');

            // บันทึกประวัติการซื้อ
            const purchases = getPurchases();
            if (!purchases[interaction.user.id]) purchases[interaction.user.id] = [];
            purchases[interaction.user.id].push({
                productName: product.name,
                price: product.price,
                date: new Date().toISOString()
            });
            savePurchases(purchases);

            const downloadLink = (product.gofileUrl && product.gofileUrl.trim() !== "") ? `[คลิกเพื่อดาวน์โหลดไฟล์](${product.gofileUrl})` : "ไม่มีลิงก์ดาวน์โหลดไฟล์";

            const successEmbed = new EmbedBuilder()
                .setColor("Green")
                .setTitle("✅ สั่งซื้อสินค้าสำเร็จ!")
                .setDescription(`คุณได้ทำการซื้อ **${product.name}** เรียบร้อยแล้ว`)
                .addFields(
                    { name: "🔗 ลิงก์ดาวน์โหลดสินค้า", value: downloadLink, inline: false },
                    { name: "💳 ยอดเงินคงเหลือ", value: `${balances[interaction.user.id]} บาท`, inline: false }
                );

            if (product.previewImage && product.previewImage.trim() !== "") {
                successEmbed.setImage(product.previewImage);
            }

            await interaction.update({
                content: null,
                embeds: [successEmbed],
                components: [],
                ephemeral: true
            });

            // ส่ง Log ไปห้อง Log
            const logChannel = interaction.guild.channels.cache.get(config.channellog);
            if (logChannel) {
                logChannel.send({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle("🛒 มีการซื้อสินค้าสำเร็จ")
                            .setDescription(`ผู้ซื้อ: <@${interaction.user.id}>\nสินค้า: **${product.name}**\nราคา: **${product.price} บาท**\n📦 สต็อกคงเหลือ: **${product.stock} ชิ้น**`)
                            .setColor("Green")
                            .setTimestamp()
                    ]
                });
            }
        }
    }

    // 4. Modal Submit
    if (interaction.isModalSubmit()) {
        if (interaction.customId === "topup_modal") {
            const codeInput = interaction.fields.getTextInputValue('codeInput');
            await interaction.deferReply({ ephemeral: true }); 

            if (!codeInput.includes("https://gift.truemoney.com/campaign/?v")) {
                return await interaction.editReply({ embeds: [new EmbedBuilder().setColor("Red").setDescription('❌ เติมเงินไม่สำเร็จ: ลิ้งค์ซองอั่งเปาไม่ถูกต้อง')] });
            }

            tw(config.phone, codeInput).then(async (re) => {
                const amount = re.amount;
                
                const balances = getBalances();
                if (!balances[interaction.user.id]) balances[interaction.user.id] = 0;
                balances[interaction.user.id] += amount;
                saveBalances(balances);

                await interaction.editReply({
                    embeds: [
                        new EmbedBuilder()
                            .setColor("Green")
                            .setTitle("✅ เติมเงินสำเร็จ!")
                            .setDescription(`เติมเงินสำเร็จจำนวน **${amount} บาท**\n💰 ยอดเงินสะสมในบัญชีของคุณตอนนี้: **${balances[interaction.user.id]} บาท**`)
                    ]
                });

                const logChannel = interaction.guild.channels.cache.get(config.channellog);
                if (logChannel) {
                    logChannel.send({
                        embeds: [
                            new EmbedBuilder()
                                .setTitle("💸 ประวัติการเติมเงินเข้ากระเป๋า")
                                .setDescription(`ผู้เติม: <@${interaction.user.id}>\nจำนวนเงิน: **${amount} บาท**`)
                                .setColor("Green")
                                .setTimestamp()
                        ]
                    });
                }
            }).catch(async () => {
                await interaction.editReply({ embeds: [new EmbedBuilder().setColor("Red").setDescription("❌ เติมเงินไม่ผ่าน: ลิงก์ผิด, มีคนใช้ไปแล้ว หรือซองหมดอายุ")] });
            });
        }

        if (interaction.customId === "setup2_modal") {
            if (!config.products) config.products = [];
            const newId = `prod_${config.products.length + 1}`;

            const newProd = {
                id: newId,
                name: interaction.fields.getTextInputValue('prod_name'),
                price: parseFloat(interaction.fields.getTextInputValue('prod_price')) || 0,
                stock: parseInt(interaction.fields.getTextInputValue('prod_stock')) || 0,
                gofileUrl: interaction.fields.getTextInputValue('prod_gofile') || "",
                previewImage: interaction.fields.getTextInputValue('prod_image') || ""
            };

            config.products.push(newProd);
            fs.writeFileSync('./config.json', JSON.stringify(config, null, 4), 'utf8');

            await interaction.reply({
                content: `✅ เพิ่มสินค้า **${newProd.name}** (ID: \`${newId}\` | จำนวนสต็อก: **${newProd.stock} ชิ้น**) เข้าสู่ระบบเรียบร้อยแล้ว!`,
                ephemeral: true
            });
        }
    }
});

process.on('unhandledRejection', (reason, p) => console.log(' [Anti-Crash] :: Unhandled Rejection'));
process.on('uncaughtException', (err, origin) => console.log(' [Anti-Crash] :: Uncaught Exception'));

client.login(botToken);
