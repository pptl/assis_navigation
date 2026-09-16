export const customers = {
  search: () => post("Customers/CustomerSearch"),
  detail: () => post("Customers/CustomerDetail"),
  create: () => post("Customers/CustomerCreate"),
  report: () => post("Customers/CustomerReport"),
  stats: () => post("Customers/CustomerStatistics"),
};
declare function post(url: string): unknown;
