// Thelander 2026 equity survey — Series B cut. Market "% of Fully Diluted
// Shares (Non-Founder)" per role, as decimals (0.0007 = 0.07%). Generated from
// the source workbook; regenerate when the survey updates.
export interface MarketBand { n: number; min: number | null; p25: number | null; med: number | null; p75: number | null; max: number | null }

export const THELANDER_EQUITY: Record<string, MarketBand> = {
  "Accountant - Sr": { n: 4, min: 0.00017, p25: 0.0004175, med: 0.00065, p75: 0.0008500000000000001, max: 0.001 },
  "Accountant - Staff": { n: 3, min: 0.00017999999999999998, p25: 0.000349, med: 0.000518, p75: 0.0007589999999999999, max: 0.001 },
  "Assembler": { n: 6, min: 0.00002, p25: 0.000125, med: 0.0002, p75: 0.0002075, max: 0.00021 },
  "CEO": { n: 7, min: 0.02, p25: 0.03125, med: 0.041315, p75: 0.0535, max: 0.07 },
  "CFO": { n: 12, min: 0.0013, p25: 0.008, med: 0.01, p75: 0.015625, max: 0.095 },
  "Chief Commercial Officer": { n: 4, min: 0.009000000000000001, p25: 0.009675, med: 0.00995, p75: 0.01075, max: 0.013000000000000001 },
  "Chief Medical Officer": { n: 6, min: 0.0084, p25: 0.0335, med: 0.0365, p75: 0.047, max: 0.08 },
  "Clinical Field Specialist": { n: 5, min: 0.00018, p25: 0.0005, med: 0.0007000000000000001, p75: 0.0007000000000000001, max: 0.001568 },
  "Clinical Research Associate": { n: 3, min: 0.0002, p25: 0.00025, med: 0.0003, p75: 0.0005149999999999999, max: 0.00073 },
  "Clinical Research Manager": { n: 3, min: 0.0006, p25: 0.0009795, med: 0.001359, p75: 0.0017295, max: 0.0021 },
  "Clinical Trial Manager": { n: 4, min: 0.0007000000000000001, p25: 0.00085, med: 0.0011799999999999998, p75: 0.001595, max: 0.002 },
  "Controller": { n: 11, min: 0.001, p25: 0.0013975, med: 0.00197, p75: 0.005705, max: 0.01387 },
  "COO": { n: 4, min: 0.01, p25: 0.010750000000000003, med: 0.012435, p75: 0.0204025, max: 0.04 },
  "Director Clinical Operations": { n: 9, min: 0.0007000000000000001, p25: 0.0013, med: 0.0015, p75: 0.005, max: 0.01 },
  "Director Clinical Trials": { n: 6, min: 0.0012950000000000001, p25: 0.0017299999999999998, med: 0.0022500000000000003, p75: 0.0035275000000000003, max: 0.010469 },
  "Director Engineering": { n: 7, min: 0.0017000000000000001, p25: 0.00191, med: 0.00219, p75: 0.0028000000000000004, max: 0.005431 },
  "Director Finance": { n: 3, min: 0.001, p25: 0.00116, med: 0.00132, p75: 0.00136, max: 0.0014000000000000002 },
  "Director Operations": { n: 5, min: 0.002, p25: 0.00231, med: 0.0025, p75: 0.0025, max: 0.005 },
  "Director Quality Control - Scientific": { n: 4, min: 0.001, p25: 0.001225, med: 0.001585, p75: 0.00192525, max: 0.002091 },
  "Director R&D - Technical": { n: 4, min: 0.0007000000000000001, p25: 0.000925, med: 0.0022, p75: 0.00505, max: 0.01 },
  "Director Regulatory": { n: 4, min: 0.0004, p25: 0.00055, med: 0.0008824999999999999, p75: 0.0013965, max: 0.002091 },
  "Engineer - Biomedical": { n: 3, min: 0.0004, p25: 0.00045, med: 0.0005, p75: 0.0005, max: 0.0005 },
  "Engineer - Lead/Principal Research and Development": { n: 3, min: 0.0015, p25: 0.0017499999999999998, med: 0.002, p75: 0.004745, max: 0.00749 },
  "Engineer - Manufacturing": { n: 6, min: 0.0001, p25: 0.000265, med: 0.00048, p75: 0.0006725, max: 0.001 },
  "Engineer - Research and Development": { n: 8, min: 0.00024, p25: 0.0005375, med: 0.000625, p75: 0.000965, max: 0.0016 },
  "Engineer - Senior Mechanical": { n: 3, min: 0.0001, p25: 0.0004, med: 0.0007000000000000001, p75: 0.0008100000000000001, max: 0.00092 },
  "Engineer - Senior Research and Development": { n: 5, min: 0.0004, p25: 0.0004, med: 0.00073, p75: 0.0012, max: 0.0013900000000000002 },
  "HR Manager": { n: 4, min: 0.0001, p25: 0.0001, med: 0.00028000000000000003, p75: 0.0005949999999999999, max: 0.001 },
  "Office Management": { n: 6, min: 0.0004, p25: 0.00041, med: 0.00047, p75: 0.002, max: 0.0025 },
  "Quality Control Manager - Scientific": { n: 4, min: 0.0007000000000000001, p25: 0.00085, med: 0.0015, p75: 0.0021, max: 0.0021 },
  "Quality Control Manager - Technical": { n: 3, min: 0.0003, p25: 0.0004, med: 0.0005, p75: 0.0007050000000000001, max: 0.00091 },
  "VP Clinical Development": { n: 7, min: 0.0064, p25: 0.0085, med: 0.01, p75: 0.0175, max: 0.03 },
  "VP Clinical Operations": { n: 3, min: 0.00555, p25: 0.006775, med: 0.008, p75: 0.009000000000000001, max: 0.01 },
  "VP Engineering": { n: 4, min: 0.0034999999999999996, p25: 0.0038824999999999997, med: 0.004505, p75: 0.00625, max: 0.01 },
  "VP Finance": { n: 5, min: 0.0015, p25: 0.006, med: 0.0075, p75: 0.01, max: 0.01 },
  "VP Human Resources": { n: 3, min: 0.0013, p25: 0.00565, med: 0.01, p75: 0.011000000000000001, max: 0.012 },
  "VP Medical Affairs": { n: 3, min: 0.0013, p25: 0.00315, med: 0.005, p75: 0.0125, max: 0.02 },
  "VP Operations": { n: 10, min: 0.0025, p25: 0.005, med: 0.007005, p75: 0.0095, max: 0.01 },
  "VP R&D": { n: 10, min: 0.002, p25: 0.005350000000000001, med: 0.00775, p75: 0.01325, max: 0.015 },
  "VP Regulatory": { n: 10, min: 0.0017000000000000001, p25: 0.004365, med: 0.0085, p75: 0.01, max: 0.0319 },
}

export const THELANDER_ROLES = Object.keys(THELANDER_EQUITY)
