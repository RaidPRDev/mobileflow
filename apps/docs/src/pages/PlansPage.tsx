export function PlansPage() {
  return (
    <div>
      <h1>Subscription Plans</h1>
      <p>
        MobileFlow uses Stripe for billing. Each organization subscribes to a
        plan that controls app limits, seats, and concurrent build capacity.
      </p>

      <h2>Plan tiers</h2>
      <div className="plans-table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Plan</th>
              <th>Price</th>
              <th>Apps</th>
              <th>Seats</th>
              <th>Concurrent Builds</th>
              <th>Builds Enabled</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>Naboria</strong></td>
              <td>Free</td>
              <td>0</td>
              <td>1</td>
              <td>0</td>
              <td>No (read-only / demo)</td>
            </tr>
            <tr>
              <td><strong>Bohío</strong></td>
              <td>$9.99/mo</td>
              <td>1</td>
              <td>1</td>
              <td>1</td>
              <td>Yes</td>
            </tr>
            <tr>
              <td><strong>Yucayeque</strong></td>
              <td>$14.99/mo</td>
              <td>2</td>
              <td>1</td>
              <td>2</td>
              <td>Yes</td>
            </tr>
            <tr>
              <td><strong>Cacique</strong></td>
              <td>$24.99/mo</td>
              <td>6</td>
              <td>6</td>
              <td>3</td>
              <td>Yes</td>
            </tr>
            <tr>
              <td><strong>Unlimited</strong></td>
              <td>Internal</td>
              <td>∞</td>
              <td>∞</td>
              <td>∞</td>
              <td>Yes</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>Naboria (free tier)</h2>
      <p>
        Naboria is a read-only demo plan. Users can sign up, browse the UI, and
        see demo content, but they cannot create apps or run builds. This
        protects compute resources from free-tier abuse.
      </p>

      <h2>Enforcement points</h2>
      <ul>
        <li>
          <strong>App create</strong>: rejected if{" "}
          <code>apps_count &gt;= plan.max_apps</code>.
        </li>
        <li>
          <strong>Member invite</strong>: rejected if{" "}
          <code>seats_count &gt;= plan.max_seats</code>.
        </li>
        <li>
          <strong>Build enqueue</strong>: rejected if{" "}
          <code>plan.can_build = false</code>. While running, the queue waits
          for a slot if <code>running_builds_for_org &gt;= plan.max_concurrent_builds</code>.
        </li>
      </ul>
      <p>
        All checks are enforced server-side. The UI also disables CTAs and shows
        explanatory tooltips when a limit would be exceeded.
      </p>

      <h2>Stripe integration</h2>
      <ul>
        <li>Checkout sessions are created for plan upgrades.</li>
        <li>Customer Portal is used for payment method and subscription management.</li>
        <li>
          Webhooks handle{" "}
          <code>checkout.session.completed</code>,{" "}
          <code>customer.subscription.created</code>,{" "}
          <code>customer.subscription.updated</code>, and{" "}
          <code>customer.subscription.deleted</code>.
        </li>
        <li>
          The <code>unlimited</code> plan is internal and never shown in the
          public pricing UI.
        </li>
      </ul>
    </div>
  );
}
