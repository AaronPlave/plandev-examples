package scheduling.generated;

import gov.nasa.ammos.plandev.contrib.serialization.mappers.RecordValueMapper;
import gov.nasa.ammos.plandev.merlin.framework.ValueMapper;
import gov.nasa.ammos.plandev.merlin.protocol.types.Duration;
import java.util.List;
import javax.annotation.processing.Generated;
import scheduling.procedures.ScheduleHopTraverse;

@Generated("gov.nasa.ammos.plandev.procedural.processor.ProcedureProcessor")
@SuppressWarnings("unchecked")
public final class AutoValueMappers {
  public static ValueMapper<ScheduleHopTraverse> scheduling_procedures_ScheduleHopTraverse(
      final ValueMapper<String> sites_ValueMapper, final ValueMapper<String> order_ValueMapper,
      final ValueMapper<Duration> startAfter_ValueMapper,
      final ValueMapper<Duration> restAfterHop_ValueMapper,
      final ValueMapper<Duration> pictureDuration_ValueMapper) {
    return new RecordValueMapper<>(
      ScheduleHopTraverse.class,
      List.of(
        new RecordValueMapper.Component<>(
          "sites",
          ScheduleHopTraverse::sites,
          sites_ValueMapper),
        new RecordValueMapper.Component<>(
          "order",
          ScheduleHopTraverse::order,
          order_ValueMapper),
        new RecordValueMapper.Component<>(
          "startAfter",
          ScheduleHopTraverse::startAfter,
          startAfter_ValueMapper),
        new RecordValueMapper.Component<>(
          "restAfterHop",
          ScheduleHopTraverse::restAfterHop,
          restAfterHop_ValueMapper),
        new RecordValueMapper.Component<>(
          "pictureDuration",
          ScheduleHopTraverse::pictureDuration,
          pictureDuration_ValueMapper)));
  }
}
