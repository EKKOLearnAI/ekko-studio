export interface ChangelogEntry {
  version: string
  date: string
  changes: string[]
}

export const changelog: ChangelogEntry[] = [
  {
    version: '0.7.30',
    date: '2026-10-05',
    changes: [
      'changelog.new_0_7_30_1',
      'changelog.new_0_7_30_2',
      'changelog.new_0_7_30_3',
      'changelog.new_0_7_30_4',
      'changelog.new_0_7_30_5',
      'changelog.new_0_7_30_6',
      'changelog.new_0_7_30_7',
      'changelog.new_0_7_30_8',
    ],
  },
  {
    version: '0.7.29',
    date: '2026-10-03',
    changes: [
      'changelog.new_0_7_29_1',
      'changelog.new_0_7_29_2',
    ],
  },
  {
    version: '0.7.28',
    date: '2026-10-02',
    changes: [
      'changelog.new_0_7_28_1',
      'changelog.new_0_7_28_2',
      'changelog.new_0_7_28_3',
      'changelog.new_0_7_28_4',
      'changelog.new_0_7_28_5',
      'changelog.new_0_7_28_6',
    ],
  },
]
