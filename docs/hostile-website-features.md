# Hostile Website Specification

This document defines the behaviors a hostile website should include in order to simulate the real-world challenges of integrating with legacy veterinary PIMS systems. The goal is to create an environment that forces an integration layer or Chrome extension to handle instability, inconsistency, and ambiguity at every level.

## 1. DOM Instability

A hostile site should never present a stable or predictable DOM. IDs should change on every load and sometimes collide. Classes should be reused for unrelated elements so selectors cannot be trusted. The DOM should re-render sections without warning, replacing nodes even when the visible content does not change. The HTML should be imperfect, with unclosed tags, nested tables, and outdated elements like font tags. This creates a surface where naive scraping fails immediately.

## 2. Asynchronous and Staggered Rendering

Data should not appear all at once. Client information might load first, line items later, and totals after that. Some sections should fail to load occasionally or load twice with different values. Placeholders should linger longer than expected. This forces the integration layer to detect readiness rather than rely on timing.

## 3. Navigation Without URL Changes

Tabs should switch content without altering the URL. Some tabs should hide content with CSS while others physically move nodes around the DOM. Iframes should be used for key content, and those iframes should load slowly or reload when switching tabs. Some invoice views should open in popup windows created with window.open. This simulates the fractured navigation patterns of real PIMS systems.

## 4. Data Layout That Defies Structure

Invoice data should be split across multiple areas. Client and patient information might appear in one region, line items in another, and totals in a floating container. Duplicate tables should exist, some real and some decoys. Hidden tables with stale data should remain in the DOM. Layout tables should be mixed with data tables so structure cannot be inferred from markup alone.

## 5. Inconsistent Formatting and Localization

Currency should appear in multiple formats on the same page. Dates should follow different conventions. Whitespace should include non-breaking spaces, zero-width characters, and irregular spacing. These inconsistencies force the integration layer to normalize values rather than rely on simple parsing.

## 6. Anti Automation Behaviors

Some elements should look like data but contain misleading values. Scripts should rewrite parts of the DOM after initial load. Certain data should only appear after scrolling or after clicking a button that looks decorative. Some content should disappear if interacted with too quickly. These behaviors simulate the accidental or intentional traps found in older systems.

## 7. Version Drift Simulation

The site should behave differently on each reload. Column order might change, labels might shift, and new fields might appear. Load timing should vary. A version flag can control which structure appears, creating a sense of evolving software that breaks integrations unexpectedly.

## 8. Network and Latency Problems

Requests should be slow, with random delays. Some loads should fail with errors or timeouts. Occasionally the site should simulate offline mode and show cached or partial data. This mirrors the unreliable networks found in many clinics.

## 9. Security and Access Constraints

The site should mix HTTP and HTTPS resources. Some iframes should block access. Right-click and text selection should be disabled in certain areas. These constraints mimic the awkward security behaviors of older systems without implementing real security.

## 10. Visual and Structural Noise

The interface should feel cluttered. Toolbars, sidebars, alerts, and decorative elements should crowd the page. Divs should be nested deeply. Inline styles should override each other. Redundant values should appear in multiple places, sometimes conflicting. This creates the cognitive load typical of legacy PIMS interfaces.

## Summary

A complete hostile website includes unstable markup, unpredictable rendering, inconsistent formatting, misleading elements, version drift, latency issues, and visual clutter. The purpose is to force any integration layer to rely on resilient strategies rather than assumptions about structure or timing.
