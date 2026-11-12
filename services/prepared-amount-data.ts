/**
 * The exact amount a form will prepare, as a DOM attribute on its amount field
 * (`data-prepared-amount`), so the browser smokes can check the amount a flow
 * hands to the SDK against the share rate the page received, instead of the
 * figure on screen (which is the coin either way).
 *
 * For a yield share the field shows the coin ("10 USDC") while the form holds
 * exact shares. A bug that stores the typed coin as shares looks identical on
 * screen, so the smoke needs the held value. react-native-web turns `dataSet`
 * into data-* attributes; native host components drop the unknown prop.
 *
 * Local only: nothing here is sent anywhere.
 */
export function preparedAmountData(amount: string): { dataSet: { preparedAmount: string } } {
  return { dataSet: { preparedAmount: amount } };
}
