import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type ReviewCommentsPlugin from "./main";
import { TYPES } from "./constants";
import {
  LanguageSetting,
  LOCALE_LABELS,
  StringKey,
  SUPPORTED_LOCALES,
} from "./i18n";

export interface ReviewCommentsSettings {
  authorName: string;
  dateFormat: "iso" | "japanese";
  language: LanguageSetting;
  // コメント1件ごとのノートを置くフォルダ。記法から作り直せる派生物
  commentNotesFolder: string;
  // 解決したコメントの控えを置くフォルダ。中は解決した月ごとに分ける
  resolvedFolder: string;
  // 保存した直後に、そのファイルのコメントノートだけ書き直すかどうか
  autoSync: boolean;
  // 音声入力。既定は内蔵の音声認識で、費用も通信先の指定も要らない
  dictationMode: "endpoint" | "off";
  // 別の宛先を選んだときだけ使う。既定はすべて空で、通信は起きない
  dictationApiKey: string;
  dictationEndpoint: string;
  dictationModel: string;
}

export const DEFAULT_SETTINGS: ReviewCommentsSettings = {
  authorName: "you",
  dateFormat: "iso",
  language: "auto",
  commentNotesFolder: "Review Comments/notes",
  resolvedFolder: "Review Comments/resolved",
  autoSync: false,
  dictationMode: "off",
  dictationApiKey: "",
  dictationEndpoint: "",
  dictationModel: "",
};

export class ReviewCommentsSettingTab extends PluginSettingTab {
  plugin: ReviewCommentsPlugin;

  constructor(app: App, plugin: ReviewCommentsPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    const t = (key: StringKey, vars?: Record<string, string>) =>
      this.plugin.i18n.t(key, vars);

    new Setting(containerEl)
      .setName(t("settings.authorName"))
      .setDesc(t("settings.authorNameDesc"))
      .addText((text) =>
        text
          .setValue(this.plugin.settings.authorName)
          .onChange(async (value) => {
            this.plugin.settings.authorName = value || "you";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(t("settings.dateFormat"))
      .addDropdown((dd) =>
        dd
          .addOption("iso", "2026-05-13")
          .addOption("japanese", "2026年05月13日")
          .setValue(this.plugin.settings.dateFormat)
          .onChange(async (value: string) => {
            this.plugin.settings.dateFormat = value as "iso" | "japanese";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(t("settings.language"))
      .setDesc(t("settings.languageDesc"))
      .addDropdown((dd) => {
        dd.addOption("auto", t("locale.auto"));
        for (const locale of SUPPORTED_LOCALES) {
          dd.addOption(locale, LOCALE_LABELS[locale]);
        }
        dd.setValue(this.plugin.settings.language).onChange(
          async (value: string) => {
            this.plugin.settings.language = value as LanguageSetting;
            await this.plugin.saveSettings();
            this.plugin.refreshLocale();
            new Notice(this.plugin.i18n.t("settings.languageReloadNotice"));
            this.display();
          },
        );
      });

    new Setting(containerEl)
      .setName(t("settings.commentNotesFolder"))
      .setDesc(t("settings.commentNotesFolderDesc"))
      .addText((text) =>
        text
          .setValue(this.plugin.settings.commentNotesFolder)
          .onChange(async (value) => {
            this.plugin.settings.commentNotesFolder =
              value.trim() || DEFAULT_SETTINGS.commentNotesFolder;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(t("settings.autoSync"))
      .setDesc(t("settings.autoSyncDesc"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoSync)
          .onChange(async (value) => {
            this.plugin.settings.autoSync = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(t("settings.resolvedFolder"))
      .setDesc(t("settings.resolvedFolderDesc"))
      .addText((text) =>
        text
          .setValue(this.plugin.settings.resolvedFolder)
          .onChange(async (value) => {
            this.plugin.settings.resolvedFolder =
              value.trim() || DEFAULT_SETTINGS.resolvedFolder;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setName(t("settings.dictationMode")).setHeading();

    new Setting(containerEl)
      .setName(t("settings.dictationMode"))
      .setDesc(t("settings.dictationModeDesc"))
      .addDropdown((dd) => {
        dd.addOption("off", t("dictation.modeOff"));
        dd.addOption("endpoint", t("dictation.modeEndpoint"));
        dd.setValue(this.plugin.settings.dictationMode).onChange(
          async (value: string) => {
            this.plugin.settings.dictationMode =
              value as ReviewCommentsSettings["dictationMode"];
            await this.plugin.saveSettings();
            this.display();
          },
        );
      });

    // 別の宛先を選んだときだけ、宛先と鍵とモデルを出す
    if (this.plugin.settings.dictationMode === "endpoint") {
      new Setting(containerEl)
        .setName(t("settings.dictationApiKey"))
        .setDesc(t("settings.dictationApiKeyDesc"))
        .addText((text) =>
          text
            .setValue(this.plugin.settings.dictationApiKey)
            .onChange(async (value) => {
              this.plugin.settings.dictationApiKey = value.trim();
              await this.plugin.saveSettings();
            }),
        );

      new Setting(containerEl)
        .setName(t("settings.dictationEndpoint"))
        .setDesc(t("settings.dictationEndpointDesc"))
        .addText((text) =>
          text
            .setValue(this.plugin.settings.dictationEndpoint)
            .onChange(async (value) => {
              this.plugin.settings.dictationEndpoint = value.trim();
              await this.plugin.saveSettings();
            }),
        );

      new Setting(containerEl)
        .setName(t("settings.dictationModel"))
        .setDesc(t("settings.dictationModelDesc"))
        .addText((text) =>
          text
            .setValue(this.plugin.settings.dictationModel)
            .onChange(async (value) => {
              this.plugin.settings.dictationModel = value.trim();
              await this.plugin.saveSettings();
            }),
        );
    }

    new Setting(containerEl)
      .setName(t("settings.commentTypesHeading"))
      .setHeading();

    const list = containerEl.createEl("ul");
    for (const type of TYPES) {
      const li = list.createEl("li");
      const label = t(type.labelKey);
      li.textContent = t("settings.commentTypeItemTemplate", {
        icon: type.icon,
        label,
        tag: type.tag,
        // 実際に登録されるコマンド名と同じ文字列を差し込む
        command: t("command.addCommentTemplate", {
          type: label,
          icon: type.icon,
        }),
      });
    }

    containerEl.createEl("p", {
      text: t("settings.commentTypesDesc"),
      cls: "setting-item-description",
    });
  }
}
