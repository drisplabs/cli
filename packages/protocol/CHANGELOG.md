# Changelog

## [0.6.0](https://github.com/drisplabs/cli/compare/protocol-v0.1.0...protocol-v0.6.0) (2026-09-05)


### Features

* **doctor:** discover API keys from /login storage and managed-settings drop-ins ([e4bc469](https://github.com/drisplabs/cli/commit/e4bc469dd6c3bfe97c5a80e2aac62f738312967f))
* **feed:** emit a phase event when the Turn Protocol block names a new step ([#202](https://github.com/drisplabs/cli/issues/202)) ([b6db429](https://github.com/drisplabs/cli/commit/b6db429c3168fa6fa6f6d2fea81a6cd05b1e4c61))
* protocol migration (one protocol, one runner, runs that continue without a person) ([#204](https://github.com/drisplabs/cli/issues/204)) ([e08eaa7](https://github.com/drisplabs/cli/commit/e08eaa705c1b50e3b7bf991636be4f50f78f729c))
* **protocol:** extract @drisp/protocol with new frame names accepted alongside the old ([#196](https://github.com/drisplabs/cli/issues/196)) ([37d37de](https://github.com/drisplabs/cli/commit/37d37def46fea866ba778a047968c65db117e6e7))
* rename tracker to journal, markers to NEEDS_HUMAN, exec to run, presets to guarded/standard/autonomous ([#197](https://github.com/drisplabs/cli/issues/197)) ([bca15f4](https://github.com/drisplabs/cli/commit/bca15f4a58b09d2977c09545568dfc7a2e448177))
* **runner:** drisp runner replaces the dashboard daemon ([#206](https://github.com/drisplabs/cli/issues/206)) ([5402d85](https://github.com/drisplabs/cli/commit/5402d85f53e020722d4305b38c62f17ebab5aea8))
* **runner:** report installed workflows and versions on hello ([#200](https://github.com/drisplabs/cli/issues/200)) ([8ab901e](https://github.com/drisplabs/cli/commit/8ab901e043764abd7c267dfbf8f125b309a7be40)), closes [#187](https://github.com/drisplabs/cli/issues/187)
* **runner:** speak @drisp/protocol on the instance socket with new names on the wire ([#198](https://github.com/drisplabs/cli/issues/198)) ([5c2be41](https://github.com/drisplabs/cli/commit/5c2be4102fe129cb74bd38ab68fc636209d0b232))
* **workflows:** handover cap on the Journal-hash signal ([#218](https://github.com/drisplabs/cli/issues/218)) ([670e419](https://github.com/drisplabs/cli/commit/670e419c807495591557a219d84353501c91f7b0)), closes [#210](https://github.com/drisplabs/cli/issues/210) [#164](https://github.com/drisplabs/cli/issues/164)
* **workflows:** opt-in cumulative token budget; cumulative tokens in the stream and drisp runs ([#223](https://github.com/drisplabs/cli/issues/223)) ([5a309fe](https://github.com/drisplabs/cli/commit/5a309fe375bf305bcc674462ca9f1843820da116)), closes [#215](https://github.com/drisplabs/cli/issues/215)
