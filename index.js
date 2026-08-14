const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Bot is running 24/7!');
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
const chalkRainbow = require('chalk-rainbow');

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
    description: "เรียกหน้าต่างเมนูร้านค้า (Admin Only)",
    options: []
});
commandsMap.set("setup2", {
    name: "setup2",
    description: "เพิ่มสินค้า/ตะกร้าสินค้าใหม่ผ่านฟอร์ม (Admin Only)",
    options: []
});
commandsMap.set("addmoney", {
    name: "addmoney",
    description: "เพิ่มเงินให้บัญชีผู้ใช้ (Admin Only)",
    options: [
        { name: "user", description: "เลือกผู้ใช้", type: 6, required: true },
        { name: "amount", description: "จำนวนเงินที่ต้องการเพิ่ม", type: 4, required: true }
    ]
});
commandsMap.set("removemoney", {
    name: "removemoney",
    description: "เอาเงินออกจากบัญชีผู้ใช้ (Admin Only)",
    options: [
        { name: "user", description: "เลือกผู้ใช้", type: 6, required: true },
        { name: "amount", description: "จำนวนเงินที่ต้องการหัก", type: 4, required: true }
    ]
});
commandsMap.set("checkmoney", {
    name: "checkmoney",
    description: "เช็คยอดเงินในบัญชีผู้ใช้ (Admin Only)",
    options: [
        { name: "user", description: "เลือกผู้ใช้ที่ต้องการเช็ค", type: 6, required: true }
    ]
});
commandsMap.set("checkuser", {
    name: "checkuser",
    description: "เช็คยศและประวัติการซื้อสินค้าของผู้ใช้ (Admin Only)",
    options: [
        { name: "user", description: "เลือกผู้ใช้ที่ต้องการเช็ค", type: 6, required: true }
    ]
});

const rest = new REST({ version: "9" }).setToken(config.token);

client.once("ready", () => {
    (async () => {
        try {
            let commands = Array.from(commandsMap.values());
            await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
            console.log(chalkRainbow(`✅ เข้าสู่ระบบสำเร็จในชื่อ : ${client.user.tag}`));
        } catch (err) {
            console.error(err);
        }
    })();
});

// ฟังก์ชันสร้างหน้าเมนูหลัก
function createShopMenu() {
    const embed = new EmbedBuilder()
        .setTitle('🛒 ระบบร้านค้าและเติมเงินสะสม')
        .setDescription('• เติมเงินเก็บสะสมไว้ในบัญชี\n• เลือกซื้อยศและโปรแกรมได้ทันทีผ่านปุ่มด้านล่าง')
        .setColor('Blue');
    
    if (config.imageUrl && config.imageUrl !== "") {
        embed.setImage(config.imageUrl);
    }

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('topup_menu').setLabel('💰 เติมเงิน (ซองอั่งเปา)').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('check_balance').setLabel('💳 ดูยอดเงินในบัญชี').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('buy_menu').setLabel('🛒 เลือกซื้อยศ/โปรแกรม').setStyle(ButtonStyle.Secondary)
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('view_prices').setLabel('❓ ดูราคายศและสินค้า').setStyle(ButtonStyle.Primary),
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

            // แก้ไข: ลดเหลือ 5 ช่อง (สูงสุดที่ Discord อนุญาต) โดยตัดช่อง ID ออกและใช้ระบบสร้าง ID อัตโนมัติแทน
            const modal = new ModalBuilder()
                .setCustomId('setup2_modal')
                .setTitle('➕ เพิ่มสินค้า/ตะกร้าสินค้าใหม่');

            const nameInput = new TextInputBuilder().setCustomId('prod_name').setLabel("ชื่อสินค้า/ยศ").setStyle(TextInputStyle.Short).setRequired(true);
            const priceInput = new TextInputBuilder().setCustomId('prod_price').setLabel("ราคา (บาท)").setStyle(TextInputStyle.Short).setRequired(true);
            const roleInput = new TextInputBuilder().setCustomId('prod_roleId').setLabel("Role ID ของ Discord (เว้นว่างได้)").setStyle(TextInputStyle.Short).setRequired(false);
            const gofileInput = new TextInputBuilder().setCustomId('prod_gofile').setLabel("ลิงก์ดาวน์โหลด GoFile (ถ้ามี)").setStyle(TextInputStyle.Short).setRequired(false);
            const imageInput = new TextInputBuilder().setCustomId('prod_image').setLabel("ลิงก์ภาพตัวอย่างสินค้า (ถ้ามี)").setStyle(TextInputStyle.Short).setRequired(false);

            modal.addComponents(
                new ActionRowBuilder().addComponents(nameInput),
                new ActionRowBuilder().addComponents(priceInput),
                new ActionRowBuilder().addComponents(roleInput),
                new ActionRowBuilder().addComponents(gofileInput),
                new ActionRowBuilder().addComponents(imageInput)
            );

            return await interaction.showModal(modal);
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
            const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

            const balances = getBalances();
            const purchases = getPurchases();
            const userBalance = balances[targetUser.id] || 0;
            const userPurchases = purchases[targetUser.id] || [];

            let rolesList = member ? member.roles.cache.filter(r => r.id !== interaction.guild.id).map(r => `<@&${r.id}>`).join(', ') : "ไม่พบข้อมูลในเซิร์ฟเวอร์";
            let purchaseHistory = userPurchases.length > 0 ? userPurchases.map(p => `• **${p.productName}** (${p.price} บาท) - เมื่อ ${new Date(p.date).toLocaleString()}`).join('\n') : "ยังไม่มีประวัติการซื้อสินค้า";

            const embed = new EmbedBuilder()
                .setColor("Purple")
                .setTitle(`🔍 ข้อมูลผู้ใช้: ${targetUser.tag}`)
                .addFields(
                    { name: "💳 ยอดเงินคงเหลือ", value: `${userBalance} บาท`, inline: true },
                    { name: "🛡️ ยศทั้งหมดที่มี", value: rolesList || "ไม่มี", inline: false },
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
                .setPlaceholder('เลือกสินค้า/ยศที่คุณต้องการซื้อ');

            config.products.forEach(prod => {
                selectMenu.addOptions({
                    label: prod.name,
                    description: `ราคา ${prod.price} บาท`,
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
            let desc = "📋 **รายการยศและโปรแกรมที่มีจำหน่าย:**\n\n";
            config.products.forEach((p, index) => {
                let roleDisplay = (p.roleId && p.roleId.trim() !== "") ? `<@&${p.roleId}>` : "ไม่มีการกำหนดกลุ่มยศ";
                desc += `**${index + 1}. ${p.name}**\n`;
                desc += `💵 ราคา: **${p.price} บาท**\n`;
                desc += `🛡️ ได้รับยศ: ${roleDisplay}\n`;
                desc += `🎁 ของแถม: ลิงก์ดาวน์โหลดโปรแกรม + ภาพตัวอย่าง\n-----------------------------------\n`;
            });

            await interaction.reply({
                embeds: [new EmbedBuilder().setColor("Green").setTitle("💰 ราคายศและโปรแกรมทั้งหมด").setDescription(desc)],
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

            // บันทึกประวัติการซื้อ
            const purchases = getPurchases();
            if (!purchases[interaction.user.id]) purchases[interaction.user.id] = [];
            purchases[interaction.user.id].push({
                productName: product.name,
                price: product.price,
                date: new Date().toISOString()
            });
            savePurchases(purchases);

            // ให้ยศ (ตรวจสอบความถูกต้องและป้องกัน Error บอทพัง)
            if (product.roleId && product.roleId.trim() !== "") {
                try {
                    await interaction.member.roles.add(product.roleId);
                } catch (err) {
                    console.error("ไม่สามารถเพิ่มยศได้ (ตรวจสอบสิทธิ์และลำดับยศของบอท):", err);
                }
            }

            const roleMention = (product.roleId && product.roleId.trim() !== "") ? `<@&${product.roleId}>` : "ไม่มีการกำหนดกลุ่มยศ";
            const downloadLink = (product.gofileUrl && product.gofileUrl.trim() !== "") ? `[คลิกเพื่อดาวน์โหลด](${product.gofileUrl})` : "ไม่มีลิงก์ดาวน์โหลดไฟล์";

            const successEmbed = new EmbedBuilder()
                .setColor("Green")
                .setTitle("✅ สั่งซื้อสินค้าสำเร็จ!")
                .setDescription(`คุณได้ทำการซื้อ **${product.name}** เรียบร้อยแล้ว`)
                .addFields(
                    { name: "🛡️ ยศที่ได้รับ", value: roleMention, inline: false },
                    { name: "🔗 ลิงก์ดาวน์โหลดไฟล์", value: downloadLink, inline: false },
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
                            .setDescription(`ผู้ซื้อ: <@${interaction.user.id}>\nสินค้า: **${product.name}**\nราคา: **${product.price} บาท**`)
                            .setColor("Green")
                            .setTimestamp()
                    ]
                });
            }
        }
    }

    // 4. Modal Submit
    if (interaction.isModalSubmit()) {
        // ระบบเติมเงิน
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

        // ระบบ setup2 เพิ่มสินค้าเข้า config.json อัตโนมัติ (สร้าง ID ให้อัตโนมัติ)
        if (interaction.customId === "setup2_modal") {
            if (!config.products) config.products = [];
            const newId = `prod_${config.products.length + 1}`;

            const newProd = {
                id: newId,
                name: interaction.fields.getTextInputValue('prod_name'),
                price: parseFloat(interaction.fields.getTextInputValue('prod_price')) || 0,
                roleId: interaction.fields.getTextInputValue('prod_roleId') || "",
                gofileUrl: interaction.fields.getTextInputValue('prod_gofile') || "",
                previewImage: interaction.fields.getTextInputValue('prod_image') || ""
            };

            config.products.push(newProd);

            // บันทึกลงไฟล์ config.json
            fs.writeFileSync('./config.json', JSON.stringify(config, null, 4), 'utf8');

            await interaction.reply({
                content: `✅ เพิ่มสินค้า **${newProd.name}** (ID: \`${newId}\`) เข้าสู่ระบบเรียบร้อยแล้ว! สามารถใช้คำสั่ง \`/setup\` เรียกดูร้านค้าใหม่ได้ทันที`,
                ephemeral: true
            });
        }
    }
});

process.on('unhandledRejection', (reason, p) => console.log(' [Anti-Crash] :: Unhandled Rejection'));
process.on('uncaughtException', (err, origin) => console.log(' [Anti-Crash] :: Uncaught Exception'));

client.login(config.token);