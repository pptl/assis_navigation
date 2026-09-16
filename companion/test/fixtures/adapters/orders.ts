// Fixture: a typical service layer where reads and writes are all POSTs with a trailing verb.
export const orders = {
  search: () => post("Orders/OrderSearch"),
  detail: () => post("Orders/OrderDetail"),
  report: () => post("Orders/OrderReport"),
  monthly: () => post("Orders/OrderMonthlyReport"),
  stats: () => post("Orders/OrderStatistics"),
  create: () => post("Orders/OrderCreate"),
  update: () => post("Orders/OrderUpdate"),
  remove: () => post("Orders/OrderDelete"),
  rollup: () => post("Orders/OrderRollup"),
  rollup2: () => post("Orders/OrderLineRollup"),
  importSearch: () => post("Orders/OrderImportSearch"),
  importRun: () => post("Orders/OrderImport"),
  check: () => post("Auth/Check"),
  external: () => fetch("https://example.com/not/an/endpoint"),
  lower: () => post("auth/login"),
  // acronym / qualifier suffixes that must not hide the verb
  bookingFd: () => post("MeetingRoom/MeetingRoomBookingCreateFD"),
  fromExcel: () => post("Car/CarCreateFromExcel"),
  updateIp: () => post("Work/WorkClockPlaceUpdateIP"),
  byOtherId: () => post("Car/CarUpdateByOtherID"),
  pdf: () => post("Files/UploadHtmlPDF"),
  aws: () => post("Meeting/GetMRInformationAWS"),
  listByUser: () => post("Orders/OrderListByUserFD"),
};
declare function post(url: string): unknown;
