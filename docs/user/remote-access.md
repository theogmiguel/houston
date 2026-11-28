# Remote access

How to see the environments this device reaches, and how to link many of them at once. Adding
an environment and linking one machine are described in
[Environments and task sources](connections.md).

## Map and list

The Environments section shows the environments as a **Map** or a **List**; choose with the
toggle beside its title. The map draws this device, each environment it can reach and the
machines they are linked to. A line from this device to an environment is a saved route, and
its state tells whether the route is in use, on standby or offline. A line between two
machines is a link, and a machine each way is drawn as one two-way link. Machines linked
from the same environments are grouped into a stack that opens to list them.

Select a machine, a link or a stack to open its details below the map. The details hold the
same controls as the list: reconnect, routes, access, unlink and **Add environment**. The
list stays the full equivalent of the map, and below a window width of 768 px only the list
is shown.

Drag the plus on an environment onto another machine to link them, or select several
machines with Shift and **Link several…**. Escape clears the search, then the selection.

## Link several environments

**Link several…** appears once this device has two other environments saved. Tick the machines,
pick one access level for all of them and confirm once. A machine can be ticked when this app is
connected to it with a session that may create pairing codes there and has an address another
machine can reach; the list says why when it cannot. Each machine reports its own result, the
ones that failed stay ticked so you can retry only those, and machines already linked are left
as they are. **Also link each machine back** makes each link run both ways, so agents there can
work on this machine too; a machine that cannot link back is named and stays one-way.

### From a terminal

For machines this app is not connected to, put one `<address> <pairing-code>` per line in a file
(create each code with `houston pair` on that machine) and run
`houston environment link --from <file> --access <mode>`, or `--from -` to read standard input.
It prints one result per line without the pairing codes, leaves machines already linked as they
are, and exits non-zero when any line failed, so the same file can be run again with new codes
for the failures.
