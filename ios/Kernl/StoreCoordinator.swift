import Foundation
import StoreKit
import WebKit

/// StoreKit 2 purchase and restore. A successful transaction is posted to
/// `/api/apple-verify` with the signed-in reader's Supabase access token.
/// The server, not this app, decides whether the account becomes Pro.
@MainActor
final class StoreCoordinator {
    static let shared = StoreCoordinator()

    weak var webView: WKWebView?
    private var updates: Task<Void, Never>?
    private var inflight: [UInt64: Task<[String: Any], Never>] = [:]

    private init() {}

    func start() {
        guard updates == nil else { return }
        updates = Task { [weak self] in
            for await update in Transaction.updates {
                guard let self else { return }
                _ = await self.verify(update, restored: false)
            }
        }
    }

    /// Unfinished transactions from an earlier launch. Safe to call more than once.
    func drainUnfinished() {
        Task { [weak self] in
            for await result in Transaction.unfinished {
                guard let self else { return }
                _ = await self.verify(result, restored: false)
            }
        }
    }

    func purchase(productId: String) async -> [String: Any] {
        let expected = KernlConfig.proProductID
        guard !expected.isEmpty else {
            return fail("The app is missing its subscription product.")
        }
        if !productId.isEmpty && productId != expected {
            return ["ok": false, "code": "wrong_product", "error": "That purchase is not KERNL Pro."]
        }
        do {
            let products = try await Product.products(for: [expected])
            guard let product = products.first else {
                #if DEBUG
                return fail("KERNL Pro is not available from the App Store yet. On the simulator, choose KernlProducts.storekit under the scheme’s Run options.")
                #else
                return fail("KERNL Pro is not available from the App Store yet. Please try again later.")
                #endif
            }
            switch try await product.purchase() {
            case .success(let verification):
                return await verify(verification, restored: false)
            case .userCancelled:
                return ["ok": false, "code": "cancelled"]
            case .pending:
                return ["ok": false, "code": "pending", "error": "This purchase needs approval. Pro will be added when it is approved."]
            @unknown default:
                return fail("The App Store could not complete that. Please try again.")
            }
        } catch {
            #if DEBUG
            print("[KERNL] purchase failed: \(error.localizedDescription)")
            #endif
            return fail("The App Store could not complete that. Please try again.")
        }
    }

    func restore() async -> [String: Any] {
        do {
            try await AppStore.sync()
        } catch {
            return fail("The App Store could not be reached. Please try again.")
        }
        var chosen: VerificationResult<Transaction>?
        var chosenExpiry = Date.distantPast
        for await result in Transaction.currentEntitlements {
            guard case .verified(let tx) = result else { continue }
            guard tx.productID == KernlConfig.proProductID, tx.revocationDate == nil else { continue }
            let expiry = tx.expirationDate ?? .distantFuture
            if chosen == nil || expiry > chosenExpiry {
                chosen = result
                chosenExpiry = expiry
            }
        }
        guard let chosen else {
            return ["ok": false, "code": "nothing_to_restore", "error": "No active KERNL Pro subscription was found for this Apple ID."]
        }
        return await verify(chosen, restored: true)
    }

    private func verify(_ result: VerificationResult<Transaction>, restored: Bool) async -> [String: Any] {
        let transaction: Transaction
        switch result {
        case .verified(let value):
            transaction = value
        case .unverified:
            return ["ok": false, "code": "invalid_transaction", "error": "The App Store receipt could not be verified."]
        }
        guard transaction.productID == KernlConfig.proProductID else {
            return ["ok": false, "code": "wrong_product", "error": "That purchase is not KERNL Pro."]
        }
        if let existing = inflight[transaction.id] {
            return await existing.value
        }
        let signed = result.jwsRepresentation
        let task = Task { @MainActor in
            await self.send(jws: signed, transaction: transaction, restored: restored)
        }
        inflight[transaction.id] = task
        let value = await task.value
        inflight[transaction.id] = nil
        return value
    }

    private func send(jws: String, transaction: Transaction, restored: Bool) async -> [String: Any] {
        guard let token = await accessToken(), !token.isEmpty else {
            return ["ok": false, "code": "auth_required", "error": "Please sign in before buying Pro."]
        }
        guard let endpoint = KernlConfig.webHost?.appending(path: "api/apple-verify") else {
            return fail("The app is missing its website address.")
        }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let payload = ["signedTransaction": jws, "transactionId": String(transaction.id)]
        request.httpBody = try? JSONSerialization.data(withJSONObject: payload)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
            let ok = status == 200 && Self.flag(json["ok"])
            #if DEBUG
            print("[KERNL] apple-verify status \(status) ok \(ok)")
            #endif
            // A confirmed purchase, a subscription already on another account, or a product
            // Apple will not accept again should not sit in the queue forever.
            // A missing transaction or a network failure stays unfinished so it can be retried.
            if ok || status == 403 || status == 409 {
                await transaction.finish()
            }
            var out: [String: Any] = [
                "ok": ok,
                "code": json["code"] as? String ?? "",
                "error": json["error"] as? String ?? "",
                "tier": json["tier"] as? String ?? "",
                "active": Self.flag(json["active"]),
                "restored": restored
            ]
            if !ok && (out["error"] as? String ?? "").isEmpty {
                out["error"] = "The App Store could not complete that. Please try again."
            }
            return out
        } catch {
            return fail("Apple could not be reached. Please try again.")
        }
    }

    private func accessToken() async -> String? {
        guard let webView else { return nil }
        return await withCheckedContinuation { continuation in
            webView.evaluateJavaScript("window.__kernlAccessToken ? window.__kernlAccessToken() : ''") { value, _ in
                continuation.resume(returning: value as? String)
            }
        }
    }

    private static func flag(_ value: Any?) -> Bool {
        if let value = value as? Bool { return value }
        if let value = value as? NSNumber { return value.boolValue }
        return false
    }

    private func fail(_ message: String) -> [String: Any] {
        ["ok": false, "error": message]
    }
}
