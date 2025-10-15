import { EOL } from "node:os";

export const END_SIGNAL = `SELECT '__END__';${EOL}`;
export const END_MARKERS = new Set([`[{"'__END__'":"__END__"}]`, "__END__"]);
